import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
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

type RegisteredCommand = {
  description: string;
  handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;
};

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

function initJjRepo(cwd: string): void {
  execFileSync("jj", ["git", "init"], { cwd, stdio: "ignore" });
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".pi/\n");
}

function createExtensionHarness(): {
  emit: (
    eventName: string,
    event: unknown,
    ctx: ExtensionContext,
  ) => Promise<unknown>;
  runCommand: (
    commandName: string,
    args: string,
    ctx: ExtensionContext,
  ) => Promise<void>;
  commands: Map<string, RegisteredCommand>;
  sendUserMessage: ReturnType<typeof vi.fn>;
} {
  const handlers = new Map<string, RegisteredHandler[]>();
  const commands = new Map<string, RegisteredCommand>();
  const sendUserMessage = vi.fn();
  const pi = {
    on: vi.fn((eventName: string, handler: RegisteredHandler) => {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    }),
    registerCommand: vi.fn((name: string, command: RegisteredCommand) => {
      commands.set(name, command);
    }),
    sendUserMessage,
  } as unknown as ExtensionAPI;

  simplifyCodeExtension(pi);

  return {
    async emit(eventName, event, ctx) {
      let result: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        result = await handler(event, ctx);
      }
      return result;
    },
    async runCommand(commandName, args, ctx) {
      const command = commands.get(commandName);
      if (!command) {
        throw new Error(`Command not registered: ${commandName}`);
      }
      await command.handler(args, ctx);
    },
    commands,
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

  it("parses working-copy pass commands", () => {
    expect(parseSimplifyModeCommand("/simplify-code wc")).toBe("wc");
  });
});

describe("simplify-code command", () => {
  it("registers a top-level command for autocomplete", () => {
    const { commands } = createExtensionHarness();

    expect(commands.get("simplify-code")?.description).toContain(
      "Configure simplify-code auto-trigger mode",
    );
  });

  it("reports usage as an error when run without args", async () => {
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { runCommand, sendUserMessage } = createExtensionHarness();

    await runCommand("simplify-code", "", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Usage: /simplify-code wc | /simplify-code [global|project] <yes|no|ask>",
      "error",
    );
    expect(sendUserMessage).not.toHaveBeenCalled();
  });

  it("runs project config management through the registered command", async () => {
    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { runCommand } = createExtensionHarness();

    await runCommand("simplify-code", "project ask", ctx);

    expect(
      JSON.parse(readFileSync(getProjectConfigPath(cwd).path, "utf-8")),
    ).toEqual({ mode: "ask" });
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Simplify-code project mode set to: ask. Effective mode for this cwd: ask",
      "info",
    );
  });

  it("runs a manual working-copy pass through the registered command even when auto mode is no", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    writeFileSync(
      getProjectConfigPath(cwd).path,
      JSON.stringify({ mode: "no" }),
    );
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "manual.ts"),
      "export const manual = true;\n",
    );
    const ctx = createContext(cwd);
    const { runCommand, sendUserMessage } = createExtensionHarness();

    await runCommand("simplify-code", "wc", ctx);
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const message = sendUserMessage.mock.calls[0][0] as string;
    expect(message).toContain(
      "Your expertise lies in applying project-specific best practices",
    );
    expect(message).toContain("src/manual.ts");
    expect(message).not.toMatch(/^\/simplify-code\b/);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      "Usage: /simplify-code wc | /simplify-code [global|project] <yes|no|ask>",
      "error",
    );
  });

  it("runs a manual working-copy pass through slash input", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "manual-input.ts"),
      "export const manualInput = true;\n",
    );
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    const result = await emit(
      "input",
      { type: "input", source: "interactive", text: "/simplify-code wc" },
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(result).toEqual({ action: "handled" });
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/manual-input.ts"),
    );
  });
});

describe("simplify-code auto-trigger", () => {
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

  it("sends plain-language simplification guidance after a scheduled idle check", async () => {
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
    const message = sendUserMessage.mock.calls[0][0] as string;
    expect(message).toContain(
      "Your expertise lies in applying project-specific best practices",
    );
    expect(message).toContain(
      "First commit the current changes, then simplify.",
    );
    expect(message).toContain("src/changed.ts");
    expect(message).not.toMatch(/^\/simplify-code\b/);
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

  it("does not auto-trigger another simplify pass after extension follow-up input", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emit(
      "input",
      {
        type: "input",
        source: "extension",
        text: "Your expertise lies in applying project-specific best practices to simplify and improve code without altering its behavior. Review the recently modified code and apply refinements to it. First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done.",
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

  it("promotes successful edit/write results as changed files", async () => {
    vi.useFakeTimers();

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
          path: "src/successful-edit.ts",
          oldText: "before",
          newText: "after",
        },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: {
          path: "src/successful-write.ts",
          content: "const value = 1;\n",
        },
      } satisfies ToolCallEvent,
      ctx,
    );

    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/successful-edit.ts"),
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/successful-write.ts"),
    );
  });

  it("preserves custom apply_patch compatibility after successful results", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "patch-1",
        toolName: "apply_patch",
        input: {
          patchText: [
            "*** Begin Patch",
            "*** Update File: src/custom-patch.ts",
            "@@",
            "-const value = 1;",
            "+const value = 2;",
            "*** End Patch",
          ].join("\n"),
        },
      } satisfies ToolCallEvent,
      ctx,
    );

    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining("src/custom-patch.ts"),
    );
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

  it("includes jj-discovered changed files without edit/write tool calls", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    initJjRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "from-jj.ts"),
      "export const fromJj = true;\n",
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
      expect.stringContaining("src/from-jj.ts"),
    );
  });

  it("normalizes and dedupes merged tool and VCS changed paths", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    initGitRepo(cwd);
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(
      join(cwd, "src", "normalized.ts"),
      "export const normalized = true;\n",
    );
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: {
          path: "./src\\normalized.ts",
          content: "export const normalized = true;\n",
        },
      } satisfies ToolCallEvent,
      ctx,
    );
    await emit(
      "agent_end",
      { type: "agent_end", messages: [] } satisfies AgentEndEvent,
      ctx,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const message = sendUserMessage.mock.calls[0][0] as string;
    expect(message).not.toContain("./src\\normalized.ts");
    expect(
      message.split("\n").filter((line) => line.startsWith("  - ")),
    ).toEqual(["  - src/normalized.ts"]);
  });

  it("skips auto-trigger when merged tool and VCS paths are markdown-only", async () => {
    vi.useFakeTimers();

    const cwd = createConfiguredCwd();
    initGitRepo(cwd);
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "notes.md"), "# Notes\n");
    const ctx = createContext(cwd);
    const { emit, sendUserMessage } = createExtensionHarness();

    await emitToolCallWithResult(
      emit,
      {
        type: "tool_call",
        toolCallId: "write-1",
        toolName: "write",
        input: { path: "./docs/notes.md", content: "# Notes\n" },
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
});
