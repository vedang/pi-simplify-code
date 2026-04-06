/**
 * Simplify-Code Extension
 *
 * Tracks file changes and triggers the simplify-code prompt template
 * after non-markdown code changes.
 *
 * Configuration via /simplify-code yes|no|ask:
 *   yes  - always auto-trigger (default)
 *   no   - never auto-trigger
 *   ask  - prompt user with YES/NO dialog before triggering
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extname } from "node:path";
import type {
  ExtensionAPI,
  ToolCallEvent,
} from "@mariozechner/pi-coding-agent";

// ── Configuration ────────────────────────────────────────────────
// [tag:simplify_config_mode]

type SimplifyMode = "yes" | "no" | "ask";

interface SimplifyConfig {
  mode?: SimplifyMode;
}

const VALID_MODES: ReadonlySet<string> = new Set(["yes", "no", "ask"]);
const DEFAULT_MODE: SimplifyMode = "yes";

function getConfigPath(): { dir: string; path: string } {
  const dir = join(homedir(), ".pi", "agent");
  return { dir, path: join(dir, "simplify-code.json") };
}

function loadConfig(): SimplifyConfig {
  const { path } = getConfigPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    const record = parsed as Record<string, unknown>;
    if (typeof record.mode === "string" && VALID_MODES.has(record.mode)) {
      return { mode: record.mode as SimplifyMode };
    }

    return {};
  } catch (error) {
    console.error(
      `[simplify-code] Failed to load config from ${getConfigPath().path}: ${String(error)}`,
    );
    return {};
  }
}

function saveConfig(config: SimplifyConfig): string | null {
  try {
    const { dir, path } = getConfigPath();
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
    return null;
  } catch (error) {
    return String(error);
  }
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function trimQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function normalizePath(path: string): string {
  return trimQuotes(path);
}

function isMarkdownPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return MARKDOWN_EXTENSIONS.has(extname(normalized).toLowerCase());
}

export function shouldAutoTriggerSimplify(paths: Iterable<string>): boolean {
  for (const rawPath of paths) {
    const normalized = normalizePath(rawPath);
    if (normalized && !isMarkdownPath(normalized)) {
      return true; // [tag:simplify_code_skip_markdown_only]
    }
  }
  return false;
}

export function extractPathsFromPatch(patchText: string): string[] {
  const paths: string[] = [];
  const lines = patchText.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(
      /^\*{3}\s(?:Add File|Update File|Delete File):\s(.+)$/,
    );
    if (match) {
      paths.push(trimQuotes(match[1]));
      continue;
    }
    const moveMatch = line.match(/^\*{3}\sMove to:\s(.+)$/);
    if (moveMatch) {
      paths.push(trimQuotes(moveMatch[1]));
    }
  }

  return paths;
}

function isSimplifyCommand(text: string | undefined): boolean {
  return text?.trim().toLowerCase().startsWith("/simplify-code") ?? false;
}

function recordPathsFromToolCall(
  event: ToolCallEvent,
  paths: Set<string>,
): void {
  if (event.toolName === "write" || event.toolName === "edit") {
    const input = event.input as { path?: string };
    if (typeof input.path === "string") {
      paths.add(input.path);
    }
    return;
  }

  if (event.toolName === "apply_patch") {
    const input = event.input as { patchText?: string };
    if (typeof input.patchText === "string") {
      for (const path of extractPathsFromPatch(input.patchText)) {
        paths.add(path);
      }
    }
  }
}

export default function simplifyCodeExtension(pi: ExtensionAPI): void {
  let lastInputText: string | undefined;
  let lastInputSource: "interactive" | "rpc" | "extension" | undefined;
  const pendingPaths = new Set<string>();

  const initialConfig = loadConfig();
  let mode: SimplifyMode = initialConfig.mode ?? DEFAULT_MODE;

  function formatPathsMessage(paths: Set<string>): string {
    const instruction =
      "/simplify-code First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done";

    if (paths.size === 0) {
      return instruction;
    }

    const pathList = Array.from(paths)
      .map((p) => `  - ${p}`)
      .join("\n");

    return `${instruction}\n\nThe following code paths have changed:\n${pathList}`;
  }

  pi.on("input", async (event, ctx) => {
    lastInputText = event.text;
    lastInputSource = event.source;

    // Handle config subcommands: /simplify-code yes|no|ask
    const trimmed = event.text.trim().toLowerCase();
    if (trimmed.startsWith("/simplify-code ")) {
      const arg = trimmed.slice("/simplify-code ".length).trim();
      if (VALID_MODES.has(arg)) {
        mode = arg as SimplifyMode;
        const saveError = saveConfig({ mode });
        if (saveError) {
          ctx.ui.notify(`Failed to save config: ${saveError}`, "warning");
        } else {
          ctx.ui.notify(`Simplify-code mode set to: ${mode}`, "info");
        }
        return { action: "handled" };
      }
    }
  });

  pi.on("tool_call", async (event) => {
    recordPathsFromToolCall(event, pendingPaths);
  });

  pi.on("agent_end", async (_event, ctx) => {
    // Don't trigger if there are pending messages
    if (ctx.hasPendingMessages()) {
      pendingPaths.clear();
      return;
    }

    // Avoid triggering if this was triggered by the extension itself
    if (lastInputSource === "extension" && isSimplifyCommand(lastInputText)) {
      pendingPaths.clear();
      return;
    }

    // Check mode — "no" means never auto-trigger
    if (mode === "no") {
      pendingPaths.clear();
      return;
    }

    // Only trigger if non-markdown files were changed
    if (!shouldAutoTriggerSimplify(pendingPaths)) {
      pendingPaths.clear();
      return;
    }

    // In "ask" mode, prompt the user before triggering
    if (mode === "ask") {
      // In non-interactive modes (print/JSON), confirm() returns false,
      // so fall through to auto-trigger to avoid silently skipping.
      if (ctx.hasUI) {
        const pathList = Array.from(pendingPaths)
          .map((p) => `  - ${p}`)
          .join("\n");
        const question = `Code files have changed:\n${pathList}\n\nShould I run the simplify-code pass?`;
        const ok = await ctx.ui.confirm("Simplify-Code", question);
        if (!ok) {
          pendingPaths.clear();
          return;
        }
      }
    }

    // Send the follow-up message with changed paths
    const message = formatPathsMessage(pendingPaths);
    pendingPaths.clear();

    if (ctx.isIdle()) {
      pi.sendUserMessage(message);
    } else {
      pi.sendUserMessage(message, { deliverAs: "followUp" });
    }
  });
}
