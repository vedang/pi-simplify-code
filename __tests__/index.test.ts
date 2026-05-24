import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
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
  vi.restoreAllMocks();

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

function initGitRepo(cwd: string): void {
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".pi/\n");
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

async function emitToolCallWithResult(
  emit: ReturnType<typeof createExtensionHarness>["emit"],
  toolCall: ToolCallEvent,
  ctx: ExtensionContext,
  isError = false,
): Promise<void> {
  await emit("tool_call", toolCall, ctx);
  await emit(
    "tool_result",
    {
      type: "tool_result",
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      input: toolCall.input,
      content: [],
      isError,
      details: undefined,
    } as ToolResultEvent,
    ctx,
  );
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

    await emitToolCallWithResult(
      emit,
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

    await emitToolCallWithResult(
      emit,
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

  it("defers simplify requests until a scheduled idle check", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd, { isIdle: () => true });
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
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

    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/changed.ts"),
    );
    expect(sendUserMessage.mock.calls[0]).toHaveLength(1);
  });

  it("skips scheduled simplify requests when user messages become pending", async () => {
    vi.useFakeTimers();

    let hasPendingMessages = false;
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd, {
      hasPendingMessages: () => hasPendingMessages,
      isIdle: () => true,
    });
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
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

    hasPendingMessages = true;
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not auto-trigger another simplify pass after extension simplify input", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "input",
      {
        type: "input",
        source: "extension",
        text: "/simplify-code First commit the current changes, then simplify.",
      },
      ctx,
    );
    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/simplified.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("logs changed paths when sending a scheduled simplify request fails", async () => {
    vi.useFakeTimers();

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();
    sendUserMessage.mockImplementation(() => {
      throw new Error("send failed");
    });

    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/unsent.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Failed to send simplify request"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("src/unsent.ts"),
    );
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("send failed"),
    );
  });

  it("does not treat tool calls as changed files before successful results", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/pending-write.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not treat failed edit/write results as changed files", async () => {
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "edit-1",
        toolName: "edit",
        input: {
          path: "src/failed-edit.ts",
          oldText: "before",
          newText: "after",
        },
      } satisfies ToolCallEvent,
      ctx,
      true,
    );
    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "src/failed-write.ts", content: "const value = 1;\n" },
      } satisfies ToolCallEvent,
      ctx,
      true,
    );

    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );

    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("includes VCS-discovered changed files without edit/write tool calls", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "from-bash.ts"),
      "export const fromBash = true;\n",
    );
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/from-bash.ts"),
    );
  });
});
