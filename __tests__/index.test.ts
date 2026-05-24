import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import simplifyCodeExtension, {
  getProjectConfigPath,
  parseSimplifyModeCommand,
  resolveEffectiveConfig,
} from "../src/index.ts";

type RegisteredHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createConfiguredCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-simplify-code-test-"));
  tempDirs.push(cwd);

  const configPath = getProjectConfigPath(cwd);
  mkdirSync(configPath.dir, { recursive: true });
  writeFileSync(configPath.path, JSON.stringify({ mode: "yes" }));

  return cwd;
}

function createExtensionHarness(): {
  emit: (
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<void>;
  sendUserMessage: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, RegisteredHandler[]>();
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((eventName: string, handler: RegisteredHandler) => {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    }),
    sendUserMessage,
  } as unknown as ExtensionAPI;

  simplifyCodeExtension(pi);

  return {
    async emit(eventName, event, ctx) {
      for (const handler of handlers.get(eventName) ?? []) {
        await handler(event, ctx);
      }
    },
    sendUserMessage,
  };
}

function createContext(
  cwd: string,
  overrides: Partial<
    Pick<ExtensionContext, "hasPendingMessages" | "isIdle">
  > = {},
): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(async () => true),
    },
    hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
    isIdle: overrides.isIdle ?? (() => true),
  } as unknown as ExtensionContext;
}

describe("simplify-code config helpers", () => {
  it("stores project config under cwd .pi/extensions", () => {
    expect(getProjectConfigPath("/repo")).toEqual({
      dir: "/repo/.pi/extensions",
      path: "/repo/.pi/extensions/simplify-code.json",
    });
  });

  it("merges config with project taking precedence", () => {
    expect(resolveEffectiveConfig({ mode: "no" }, { mode: "ask" })).toEqual({
      mode: "ask",
    });
  });

  it("treats bare mode commands as global", () => {
    expect(parseSimplifyModeCommand("/simplify-code yes")).toEqual({
      scope: "global",
      mode: "yes",
    });
  });

  it("supports explicit project-scoped mode commands", () => {
    expect(parseSimplifyModeCommand("/simplify-code project ask")).toEqual({
      scope: "project",
      mode: "ask",
    });
  });
});

describe("simplify-code auto-trigger", () => {
  it("does not queue non-idle agent_end simplify requests as followUp messages", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd, { isIdle: () => false });
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/changed.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );

    expect(sendUserMessage).not.toHaveBeenCalled();
    expect(sendUserMessage).not.toHaveBeenCalledWith(expect.any(String), {
      deliverAs: "followUp",
    });
  });

  it("sends a direct simplify request after non-idle agent_end becomes idle", async () => {
    vi.useFakeTimers();

    let isIdle = false;
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd, { isIdle: () => isIdle });
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/changed.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(49);
    expect(sendUserMessage).not.toHaveBeenCalled();

    isIdle = true;
    await vi.advanceTimersByTimeAsync(1);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/changed.ts"),
    );
    expect(sendUserMessage.mock.calls[0]).toHaveLength(1);
  });
});
