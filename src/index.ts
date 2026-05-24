/**
 * Simplify-Code Extension
 *
 * Tracks file changes and triggers the simplify-code prompt template
 * after non-markdown code changes.
 *
 * Auto-trigger modes:
 * - `/simplify-code yes`     - always auto-trigger (default)
 * - `/simplify-code no`      - never auto-trigger
 * - `/simplify-code ask`     - ask before triggering
 *
 * Scoped commands:
 * - `/simplify-code global yes|no|ask`  - write/interpret global config
 * - `/simplify-code project yes|no|ask` - write/interpret project config
 *
 * Config precedence:
 * defaults -> global (~/.pi/agent) -> project (<cwd>/.pi/extensions)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@mariozechner/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────
// [tag:simplify_config_mode]

type SimplifyMode = "yes" | "no" | "ask";
type SimplifyConfigScope = "global" | "project";

interface SimplifyConfig {
  mode?: SimplifyMode;
}

interface ParsedSimplifyModeCommand {
  scope: SimplifyConfigScope;
  mode: SimplifyMode;
}

const COMMAND_PREFIX = "/simplify-code";
const VALID_MODES: ReadonlySet<string> = new Set(["yes", "no", "ask"]);
const VALID_SCOPES: ReadonlySet<string> = new Set(["global", "project"]);
const DEFAULT_MODE: SimplifyMode = "yes";

export function getGlobalConfigPath(): { dir: string; path: string } {
  const dir = join(homedir(), ".pi", "agent");
  return { dir, path: join(dir, "simplify-code.json") };
}

export function getProjectConfigPath(cwd: string): {
  dir: string;
  path: string;
} {
  const dir = join(cwd, ".pi", "extensions");
  return { dir, path: join(dir, "simplify-code.json") };
}

function normalizeMode(
  record: Record<string, unknown>,
): SimplifyMode | undefined {
  if (typeof record.mode === "string" && VALID_MODES.has(record.mode)) {
    return record.mode as SimplifyMode;
  }

  return undefined;
}

function loadConfigFromPath(configPath: string): SimplifyConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const mode = normalizeMode(parsed as Record<string, unknown>);
    return mode === undefined ? {} : { mode };
  } catch (error) {
    console.error(
      `[simplify-code] Failed to load config from ${configPath}: ${String(error)}`,
    );
    return {};
  }
}

export function resolveEffectiveConfig(
  globalConfig: SimplifyConfig = {},
  projectConfig: SimplifyConfig = {},
): SimplifyConfig {
  const mode = projectConfig.mode ?? globalConfig.mode ?? DEFAULT_MODE;
  return { mode: normalizeMode({ mode }) ?? DEFAULT_MODE };
}

function saveConfigToPath(
  configPath: string,
  config: SimplifyConfig,
): string | null {
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    return null;
  } catch (error) {
    return String(error);
  }
}

function loadEffectiveMode(cwd: string): SimplifyMode {
  const globalConfig = loadConfigFromPath(getGlobalConfigPath().path);
  const projectConfig = loadConfigFromPath(getProjectConfigPath(cwd).path);
  return (
    resolveEffectiveConfig(globalConfig, projectConfig).mode ?? DEFAULT_MODE
  );
}

function getConfigPathForScope(
  scope: SimplifyConfigScope,
  cwd: string,
): { dir: string; path: string } {
  return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

export function parseSimplifyModeCommand(
  text: string,
): ParsedSimplifyModeCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith(COMMAND_PREFIX)) {
    return null;
  }

  const args = trimmed
    .slice(COMMAND_PREFIX.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (args.length === 1 && VALID_MODES.has(args[0])) {
    return {
      scope: "global",
      mode: args[0] as SimplifyMode,
    };
  }

  if (
    args.length === 2 &&
    VALID_SCOPES.has(args[0]) &&
    VALID_MODES.has(args[1])
  ) {
    return {
      scope: args[0] as SimplifyConfigScope,
      mode: args[1] as SimplifyMode,
    };
  }

  return null;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function trimQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function isMarkdownPath(path: string): boolean {
  const normalized = trimQuotes(path);
  if (!normalized) {
    return false;
  }

  return MARKDOWN_EXTENSIONS.has(extname(normalized).toLowerCase());
}

export function shouldAutoTriggerSimplify(paths: Iterable<string>): boolean {
  for (const rawPath of paths) {
    const normalized = trimQuotes(rawPath);
    if (normalized && !isMarkdownPath(normalized)) {
      return true; // [tag:simplify_code_skip_markdown_only]
    }
  }

  return false;
}

const PATCH_LINE_RE =
  /^\*{3}\s(?:Add File|Update File|Delete File|Move to):\s(.+)$/;

export function extractPathsFromPatch(patchText: string): string[] {
  const paths: string[] = [];

  for (const line of patchText.split(/\r?\n/)) {
    const match = line.match(PATCH_LINE_RE);
    if (match) {
      paths.push(trimQuotes(match[1]));
    }
  }

  return paths;
}

function isSimplifyCommand(text: string | undefined): boolean {
  return text?.trim().toLowerCase().startsWith(COMMAND_PREFIX) ?? false;
}

function formatPathList(paths: Iterable<string>): string {
  return Array.from(paths)
    .map((path) => `  - ${path}`)
    .join("\n");
}

const SIMPLIFY_IDLE_RETRY_DELAY_MS = 50;
const SIMPLIFY_IDLE_MAX_ATTEMPTS = 20;

function scheduleSimplifyAfterIdle(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  ctx: ExtensionContext,
  message: string,
): void {
  let attempts = 0;

  const tick = (): void => {
    if (ctx.hasPendingMessages()) {
      console.error(
        "[simplify-code] Skipping auto-trigger because a user message is pending.",
      );
      return;
    }

    if (!ctx.isIdle()) {
      attempts += 1;
      if (attempts >= SIMPLIFY_IDLE_MAX_ATTEMPTS) {
        console.error(
          "[simplify-code] Failed to auto-trigger because pi did not become idle.",
        );
        return;
      }

      setTimeout(tick, SIMPLIFY_IDLE_RETRY_DELAY_MS);
      return;
    }

    try {
      pi.sendUserMessage(message);
    } catch (error) {
      console.error(
        `[simplify-code] Failed to send simplify request: ${String(error)}`,
      );
    }
  };

  if (ctx.isIdle()) {
    tick();
  } else {
    setTimeout(tick, 0);
  }
}

function extractCandidatePathsFromToolCall(event: ToolCallEvent): string[] {
  if (event.toolName === "write" || event.toolName === "edit") {
    const input = event.input as { path?: string };
    return typeof input.path === "string" ? [input.path] : [];
  }

  if (event.toolName === "apply_patch") {
    const input = event.input as { patchText?: string };
    return typeof input.patchText === "string"
      ? extractPathsFromPatch(input.patchText)
      : [];
  }

  return [];
}

function recordPendingToolCall(
  event: ToolCallEvent,
  pendingToolCalls: Map<string, string[]>,
): void {
  const paths = extractCandidatePathsFromToolCall(event);
  if (paths.length > 0) {
    pendingToolCalls.set(event.toolCallId, paths);
  }
}

function promoteSuccessfulToolResult(
  event: ToolResultEvent,
  pendingToolCalls: Map<string, string[]>,
  paths: Set<string>,
): void {
  const candidatePaths = pendingToolCalls.get(event.toolCallId);
  pendingToolCalls.delete(event.toolCallId);

  if (!candidatePaths || event.isError) {
    return;
  }

  for (const path of candidatePaths) {
    paths.add(path);
  }
}

function normalizeVcsPath(path: string): string | null {
  const normalized = trimQuotes(path).replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.length > 0 ? normalized : null;
}

function parseNameOnlyOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map(normalizeVcsPath)
    .filter((path): path is string => path !== null);
}

function runVcsNameOnlyCommand(
  cwd: string,
  command: string,
  args: string[],
): string[] {
  try {
    return parseNameOnlyOutput(
      execFileSync(command, args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return [];
  }
}

function collectVcsChangedPaths(cwd: string): Set<string> {
  const paths = new Set<string>();
  const addPaths = (newPaths: Iterable<string>): void => {
    for (const path of newPaths) {
      paths.add(path);
    }
  };

  if (existsSync(join(cwd, ".jj"))) {
    addPaths(runVcsNameOnlyCommand(cwd, "jj", ["diff", "--name-only"]));
    return paths;
  }

  if (!existsSync(join(cwd, ".git"))) {
    return paths;
  }

  addPaths(
    runVcsNameOnlyCommand(cwd, "git", ["diff", "--name-only", "HEAD", "--"]),
  );
  addPaths(
    runVcsNameOnlyCommand(cwd, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]),
  );

  return paths;
}

export default function simplifyCodeExtension(pi: ExtensionAPI): void {
  let lastInputText: string | undefined;
  let lastInputSource: "interactive" | "rpc" | "extension" | undefined;
  let mode: SimplifyMode = DEFAULT_MODE;
  const pendingPaths = new Set<string>();
  const pendingToolCalls = new Map<string, string[]>();

  function refreshMode(cwd: string): void {
    mode = loadEffectiveMode(cwd);
  }

  function formatPathsMessage(paths: Set<string>): string {
    const instruction =
      "/simplify-code First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done";

    if (paths.size === 0) {
      return instruction;
    }

    const pathList = formatPathList(paths);
    return `${instruction}\n\nThe following code paths have changed:\n${pathList}`;
  }

  pi.on("input", async (event, ctx) => {
    lastInputText = event.text;
    lastInputSource = event.source;

    const command = parseSimplifyModeCommand(event.text);
    if (!command) {
      return;
    }

    const configPath = getConfigPathForScope(command.scope, ctx.cwd);
    const saveError = saveConfigToPath(configPath.path, { mode: command.mode });

    if (saveError) {
      ctx.ui.notify(
        `Failed to save simplify-code ${command.scope} config: ${saveError}`,
        "warning",
      );
    } else {
      refreshMode(ctx.cwd);
      ctx.ui.notify(
        `Simplify-code ${command.scope} mode set to: ${command.mode}. Effective mode for this cwd: ${mode}`,
        "info",
      );
    }

    return { action: "handled" };
  });

  function clearRunState(): void {
    pendingPaths.clear();
    pendingToolCalls.clear();
  }

  pi.on("tool_call", async (event) => {
    recordPendingToolCall(event, pendingToolCalls);
  });

  pi.on("tool_result", async (event) => {
    promoteSuccessfulToolResult(event, pendingToolCalls, pendingPaths);
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshMode(ctx.cwd);

    // Don't trigger if there are pending messages
    if (ctx.hasPendingMessages()) {
      clearRunState();
      return;
    }

    // Avoid triggering if this was triggered by the extension itself
    if (lastInputSource === "extension" && isSimplifyCommand(lastInputText)) {
      clearRunState();
      return;
    }

    // Check mode — "no" means never auto-trigger
    if (mode === "no") {
      clearRunState();
      return;
    }

    const changedPaths = new Set([
      ...pendingPaths,
      ...collectVcsChangedPaths(ctx.cwd),
    ]);

    // Only trigger if non-markdown files were changed
    if (!shouldAutoTriggerSimplify(changedPaths)) {
      clearRunState();
      return;
    }

    // In "ask" mode, prompt the user before triggering
    if (mode === "ask" && ctx.hasUI) {
      const pathList = formatPathList(changedPaths);
      const question = `Code files have changed:\n${pathList}\n\nShould I run the simplify-code pass?`;
      const ok = await ctx.ui.confirm("Simplify-Code", question);
      if (!ok) {
        clearRunState();
        return;
      }
    }

    // In non-interactive modes, skip confirmation and continue in auto mode.

    // Schedule the follow-up message with changed paths after this run settles.
    const message = formatPathsMessage(changedPaths);
    clearRunState();
    scheduleSimplifyAfterIdle(pi, ctx, message);
  });
}
