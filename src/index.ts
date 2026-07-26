/**
 * Simplify-Code Extension
 *
 * Tracks file changes and sends a plain-language simplify request after
 * non-markdown code changes.
 *
 * Auto-trigger modes:
 * - `/simplify-code yes`     - always auto-trigger (default)
 * - `/simplify-code no`      - never auto-trigger
 * - `/simplify-code ask`     - ask before triggering
 * - `/simplify-code wc`      - run manual working-copy pass
 *
 * Scoped commands:
 * - `/simplify-code global yes|no|ask`  - write/interpret global config
 * - `/simplify-code project yes|no|ask` - write/interpret project config
 *
 * Config precedence:
 * defaults -> global (~/.pi/agent) -> project (<cwd>/.pi/extensions)
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

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

const WORKING_COPY_COMMAND = "wc" as const;
type ParsedSimplifyCommand =
  | ParsedSimplifyModeCommand
  | typeof WORKING_COPY_COMMAND;

interface ToolCallCandidate {
  paths: string[];
}

const COMMAND_PREFIX = "/simplify-code";
const SIMPLIFY_COMMAND_USAGE =
  "Usage: /simplify-code wc | /simplify-code [global|project] <yes|no|ask>";
const FOLLOW_UP_INSTRUCTION =
  "Your expertise lies in applying project-specific best practices to simplify and improve code without altering its behavior. Review the recently modified code and apply refinements to it. First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done.";
const VALID_MODES: ReadonlySet<string> = new Set(["yes", "no", "ask"]);
const VALID_SCOPES: ReadonlySet<string> = new Set(["global", "project"]);
const DEFAULT_MODE: SimplifyMode = "yes";
const BUILT_IN_PATH_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
]);
// [tag:legacy_apply_patch_compat] `apply_patch` is not a current
// pi-coding-agent built-in. Keep this only for legacy/custom tools that emit
// patchText payloads.
const CUSTOM_PATCH_TOOL_NAME = "apply_patch";

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

export function parseSimplifyModeArgs(
  argsText: string,
): ParsedSimplifyCommand | null {
  const args = argsText.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (args.length === 1 && args[0] === WORKING_COPY_COMMAND) {
    return WORKING_COPY_COMMAND;
  }

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

export function parseSimplifyModeCommand(
  text: string,
): ParsedSimplifyCommand | null {
  const trimmed = text.trim().toLowerCase();
  if (trimmed !== COMMAND_PREFIX && !trimmed.startsWith(`${COMMAND_PREFIX} `)) {
    return null;
  }

  return parseSimplifyModeArgs(trimmed.slice(COMMAND_PREFIX.length));
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

function isExtensionSimplifyRequest(text: string | undefined): boolean {
  const trimmed = text?.trim();
  if (!trimmed) {
    return false;
  }

  return (
    trimmed.startsWith(FOLLOW_UP_INSTRUCTION) ||
    trimmed.toLowerCase().startsWith(COMMAND_PREFIX)
  );
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
        `[simplify-code] Failed to send simplify request: ${String(error)}\n${message}`,
      );
    }
  };

  setTimeout(tick, 0);
}

function extractPathsFromBuiltInPathTool(event: ToolCallEvent): string[] {
  if (!BUILT_IN_PATH_TOOL_NAMES.has(event.toolName)) {
    return [];
  }

  const input = event.input as { path?: unknown };
  return typeof input.path === "string" ? [input.path] : [];
}

function extractPathsFromCustomApplyPatchTool(event: ToolCallEvent): string[] {
  if (event.toolName !== CUSTOM_PATCH_TOOL_NAME) {
    return [];
  }

  const input = event.input as { patchText?: unknown };
  return typeof input.patchText === "string"
    ? extractPathsFromPatch(input.patchText)
    : [];
}

function extractCandidatePathsFromToolCall(event: ToolCallEvent): string[] {
  return [
    ...extractPathsFromBuiltInPathTool(event),
    ...extractPathsFromCustomApplyPatchTool(event),
  ];
}

function recordPendingToolCall(
  event: ToolCallEvent,
  pendingToolCalls: Map<string, ToolCallCandidate>,
): void {
  const paths = extractCandidatePathsFromToolCall(event);
  if (paths.length > 0) {
    pendingToolCalls.set(event.toolCallId, { paths });
  }
}

function promoteSuccessfulToolResult(
  event: ToolResultEvent,
  pendingToolCalls: Map<string, ToolCallCandidate>,
  paths: Set<string>,
): void {
  const candidate = pendingToolCalls.get(event.toolCallId);
  pendingToolCalls.delete(event.toolCallId);

  if (!candidate || event.isError) {
    return;
  }

  for (const path of candidate.paths) {
    paths.add(path);
  }
}

function isOutsideDirectory(path: string): boolean {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

function resolvePathFromCwd(cwd: string, path: string): string {
  if (!isAbsolute(path)) {
    return resolve(realpathSync(cwd), path);
  }

  const cwdRelativePath = relative(cwd, path);
  return isOutsideDirectory(cwdRelativePath)
    ? path
    : resolve(realpathSync(cwd), cwdRelativePath);
}

function normalizeChangedPath(path: string, cwd: string): string | null {
  const normalized = trimQuotes(path).replace(/\\/g, "/");
  if (!normalized) {
    return null;
  }

  const cwdRelativePath = relative(cwd, resolve(cwd, normalized));
  if (cwdRelativePath && !isOutsideDirectory(cwdRelativePath)) {
    return cwdRelativePath.split(sep).join("/");
  }

  return normalized;
}

function normalizeChangedPaths(
  cwd: string,
  paths: Iterable<string>,
): Set<string> {
  const normalizedPaths = new Set<string>();

  for (const path of paths) {
    const normalized = normalizeChangedPath(path, cwd);
    if (normalized !== null) {
      normalizedPaths.add(normalized);
    }
  }

  return normalizedPaths;
}

type GitWorktree = string | null | undefined;

function discoverGitWorktree(cwd: string): GitWorktree {
  try {
    const worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return worktree || undefined;
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? String(error.stderr)
        : "";
    return stderr.includes("not a git repository") ? null : undefined;
  }
}

function getWorktreeRelativePath(
  cwd: string,
  worktree: string,
  path: string,
): string | null {
  const worktreeRelativePath = relative(
    worktree,
    resolvePathFromCwd(cwd, path),
  );
  if (!worktreeRelativePath || isOutsideDirectory(worktreeRelativePath)) {
    return null;
  }

  return worktreeRelativePath.split(sep).join("/");
}

function commandExitStatus(error: unknown): number | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  ) {
    return error.status;
  }

  return undefined;
}

// [tag:simplify_exclude_gitignored_paths] Discover worktree roots with Git,
// then query only in-worktree paths. Keep outside tool paths; fail closed for
// in-worktree paths when Git cannot complete an ignore query.
function excludeGitIgnoredPaths(
  cwd: string,
  paths: Set<string>,
  worktree: GitWorktree,
): Set<string> {
  if (paths.size === 0 || worktree === null) {
    return paths;
  }

  if (worktree === undefined) {
    return new Set();
  }

  const outsideWorktreePaths = new Set<string>();
  const worktreePaths = new Map<string, string>();

  for (const path of paths) {
    const worktreePath = getWorktreeRelativePath(cwd, worktree, path);
    if (worktreePath === null) {
      outsideWorktreePaths.add(path);
    } else {
      worktreePaths.set(path, worktreePath);
    }
  }

  if (worktreePaths.size === 0) {
    return outsideWorktreePaths;
  }

  try {
    const ignoredPaths = new Set(
      execFileSync("git", ["check-ignore", "--no-index", "--stdin", "-z"], {
        cwd: worktree,
        encoding: "utf8",
        input: `${Array.from(worktreePaths.values()).join("\0")}\0`,
        stdio: ["pipe", "pipe", "ignore"],
      })
        .split("\0")
        .filter(Boolean),
    );

    for (const [path, worktreePath] of worktreePaths) {
      if (!ignoredPaths.has(worktreePath)) {
        outsideWorktreePaths.add(path);
      }
    }
  } catch (error) {
    if (commandExitStatus(error) === 1) {
      for (const path of worktreePaths.keys()) {
        outsideWorktreePaths.add(path);
      }
    }
  }

  return outsideWorktreePaths;
}

function parseNameOnlyOutput(output: string, cwd: string): string[] {
  return Array.from(normalizeChangedPaths(cwd, output.split(/\r?\n/)));
}

function parseGitNameOnlyOutput(
  output: string,
  cwd: string,
  worktree: string,
): string[] {
  const paths = new Set<string>();

  for (const path of output.split("\0")) {
    if (!path) {
      continue;
    }

    const cwdRelativePath = relative(
      realpathSync(cwd),
      resolve(worktree, path),
    );
    if (cwdRelativePath) {
      paths.add(cwdRelativePath.split(sep).join("/"));
    }
  }

  return Array.from(paths);
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
      cwd,
    );
  } catch {
    return [];
  }
}

function runGitNameOnlyCommand(
  cwd: string,
  worktree: string,
  args: string[],
): string[] {
  try {
    return parseGitNameOnlyOutput(
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
      cwd,
      worktree,
    );
  } catch {
    return [];
  }
}

function collectVcsChangedPaths(
  cwd: string,
  worktree: GitWorktree,
): Set<string> {
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

  if (typeof worktree !== "string") {
    return paths;
  }

  addPaths(
    runGitNameOnlyCommand(cwd, worktree, [
      "diff",
      "--name-only",
      "-z",
      "HEAD",
      "--",
    ]),
  );
  addPaths(
    runGitNameOnlyCommand(cwd, worktree, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--full-name",
      "-z",
    ]),
  );

  return paths;
}

export default function simplifyCodeExtension(pi: ExtensionAPI): void {
  let lastInputText: string | undefined;
  let lastInputSource: "interactive" | "rpc" | "extension" | undefined;
  let mode: SimplifyMode = DEFAULT_MODE;
  const pendingPaths = new Set<string>();
  const pendingToolCalls = new Map<string, ToolCallCandidate>();

  function refreshMode(cwd: string): void {
    mode = loadEffectiveMode(cwd);
  }

  function collectSimplifyCandidatePaths(cwd: string): Set<string> {
    const worktree = discoverGitWorktree(cwd);
    const paths = normalizeChangedPaths(cwd, pendingPaths);
    for (const path of collectVcsChangedPaths(cwd, worktree)) {
      paths.add(path);
    }

    return excludeGitIgnoredPaths(cwd, paths, worktree);
  }

  function formatPathsMessage(paths: Set<string>): string {
    if (paths.size === 0) {
      return FOLLOW_UP_INSTRUCTION;
    }

    const pathList = formatPathList(paths);
    return `${FOLLOW_UP_INSTRUCTION}\n\nThe following code paths have changed:\n${pathList}`;
  }

  async function maybeRunSimplifyPass(
    ctx: ExtensionContext,
    respectAutoMode: boolean,
  ): Promise<void> {
    const changedPaths = collectSimplifyCandidatePaths(ctx.cwd);

    if (!shouldAutoTriggerSimplify(changedPaths)) {
      clearRunState();
      return;
    }

    if (respectAutoMode && mode === "no") {
      clearRunState();
      return;
    }

    if (respectAutoMode && mode === "ask" && ctx.hasUI) {
      const pathList = formatPathList(changedPaths);
      const question = `Code files have changed:\n${pathList}\n\nShould I run the simplify-code pass?`;
      const ok = await ctx.ui.confirm("Simplify-Code", question);
      if (!ok) {
        clearRunState();
        return;
      }
    }

    const message = formatPathsMessage(changedPaths);
    clearRunState();
    scheduleSimplifyAfterIdle(pi, ctx, message);
  }

  function handleSimplifyModeCommand(
    command: ParsedSimplifyModeCommand,
    ctx: ExtensionContext,
  ): void {
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
  }

  pi.registerCommand("simplify-code", {
    description:
      "Configure simplify-code auto-trigger mode or run working-copy pass",
    handler: async (args, ctx) => {
      const command = parseSimplifyModeArgs(args);
      if (!command) {
        ctx.ui.notify(SIMPLIFY_COMMAND_USAGE, "error");
        return;
      }

      if (command === WORKING_COPY_COMMAND) {
        await maybeRunSimplifyPass(ctx, false);
        return;
      }

      handleSimplifyModeCommand(command, ctx);
    },
  });

  pi.on("input", async (event, ctx) => {
    lastInputText = event.text;
    lastInputSource = event.source;

    const command = parseSimplifyModeCommand(event.text);
    if (!command) {
      return;
    }

    if (command === WORKING_COPY_COMMAND) {
      await maybeRunSimplifyPass(ctx, false);
      return { action: "handled" };
    }

    handleSimplifyModeCommand(command, ctx);

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

  // Keep agent_end: this controller must schedule its follow-up before the
  // extension follow-up queue settles; agent_settled would run too late.
  pi.on("agent_end", async (_event, ctx) => {
    refreshMode(ctx.cwd);

    // Don't trigger if there are pending messages
    if (ctx.hasPendingMessages()) {
      clearRunState();
      return;
    }

    // Avoid triggering if this was triggered by the extension itself
    if (
      lastInputSource === "extension" &&
      isExtensionSimplifyRequest(lastInputText)
    ) {
      clearRunState();
      return;
    }

    await maybeRunSimplifyPass(ctx, true);
  });
}
