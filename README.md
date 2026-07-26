# Simplify-Code Extension

<p align="center">
  <img src="images/banner.png" alt="pi-simplify-code hero banner" width="100%">
</p>

Auto-simplifies after non-markdown code changes by tracking changed files, sending a short plain-language follow-up, and letting the agent apply project-specific cleanup judgment. Also supports a manual working-copy pass through `/simplify-code wc`.

## Install

```bash
# Install globally
pi install git:github.com/vedang/pi-simplify-code

# Or install for just the current project
pi install -l git:github.com/vedang/pi-simplify-code
```

## Features

- **Plain-language follow-up**: asks the model to simplify recently modified code without invoking a slash command
- **Changed-path context**: lists dirty code paths so the agent knows where to focus
- **Project standards**: lets the agent infer conventions from `AGENTS.md`, config files, and nearby code
- **Smart detection**: skips markdown-only changes and Git-ignored paths
- **Configurable mode**: supports automatic, disabled, or confirm-before-send behavior
- **Manual working-copy pass**: `/simplify-code wc` runs immediate simplify follow-up on current dirty paths regardless of auto mode

## How It Works

At `agent_end`, the extension:

1. Confirms successful `write`/`edit` tool results, discovers current dirty VCS paths when `.jj` or `.git` is available, excludes candidates matched by Git ignore rules, and keeps legacy/custom `apply_patch` payload support for providers that emit them. [ref:legacy_apply_patch_compat] [ref:simplify_path_scope_all_dirty] [ref:simplify_missing_vcs_silent_fallback] [ref:simplify_exclude_gitignored_paths]
2. Skips auto-trigger when no non-markdown files changed, when a user message is pending, when mode is `no`, or when the run was itself started by the extension.
3. Optionally asks for confirmation in `ask` mode.
4. Sends a follow-up like:

   ```text
   Your expertise lies in applying project-specific best practices to simplify and improve code without altering its behavior. Review the recently modified code and apply refinements to it. First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done.

   The following code paths have changed:
     - src/api/client.ts
     - src/utils/helpers.ts
     - tests/example.test.ts
   ```

The follow-up intentionally does **not** start with `/simplify-code`. Newer models were treating that phrase as a command to inspect. The extension now sends direct instructions instead.

## Commands

`/simplify-code` supports both config mode commands and a manual working-copy command.

### `/simplify-code wc`

Run a manual simplify pass on the current working copy immediately, regardless of effective auto mode (`yes|no|ask`), including when project mode is `no` or `ask`. This collects:

- successful `write`/`edit`/`apply_patch` tool paths seen in this run
- current dirty VCS paths from `.git`/`.jj`

The path list is normalized/deduped, Git-ignored paths are excluded, and markdown-only paths are skipped for triggering (same filtering as auto mode). [ref:simplify_exclude_gitignored_paths]

### `/simplify-code yes|no|ask`

Control auto-trigger behavior with global scope:

| Command | Behavior |
|---------|----------|
| `/simplify-code yes` | Always auto-trigger after code changes (default) |
| `/simplify-code no` | Never auto-trigger |
| `/simplify-code ask` | Show a YES/NO dialog before sending follow-up |

The setting persists globally in `~/.pi/agent/simplify-code.json`.

### `/simplify-code global yes|no|ask`

Explicitly set global mode. Writes to `~/.pi/agent/simplify-code.json`.

### `/simplify-code project yes|no|ask`

Explicitly set project mode. Writes to `<cwd>/.pi/extensions/simplify-code.json` using the current session cwd.

Project mode overrides global mode for matching sessions.

## Auto-Trigger Rules

The extension sends this auto-trigger follow-up at `agent_end` when:

1. At least one non-Git-ignored file was modified [ref:simplify_exclude_gitignored_paths]
2. At least one remaining modified file is non-markdown (`.md`, `.mdx`, `.markdown` are skipped) [ref:simplify_code_skip_markdown_only]
3. Trigger did not come from the extension itself, preventing loops
4. No user message is pending ([tag:simplify_skip_pending_user_message])
5. Effective mode is not `no`

If a user message is already pending at `agent_end`, or appears before the scheduled idle send, auto-trigger is skipped instead of deferred. User intent wins.

`/simplify-code wc` bypasses auto-mode and runs the same path-collection/follow-up pipeline without checking configured mode or confirm flow.

Path scope uses all current dirty VCS code paths at `agent_end`, not only paths newly dirtied during the last agent run. This catches changes made through `bash`, external helpers, and already-dirty files that the simplify pass should consider before committing current work. Tradeoff: if you begin a run with unrelated dirty files, they can appear in the simplify path list too; start from a clean working tree when you need a run-scoped list. [tag:simplify_path_scope_all_dirty]

When Git metadata and the Git command are available, candidates matching standard Git ignore sources (`.gitignore`, `.git/info/exclude`, and global excludes) are removed before triggering or displaying paths. Paths outside the worktree remain eligible but are never sent to Git's ignore query. If that query fails unexpectedly, uncertain in-worktree candidates are dropped rather than exposed. [ref:simplify_exclude_gitignored_paths]

When the cwd is confirmed as a non-repository, auto-trigger silently falls back to confirmed tool-result paths. This keeps scratch directories usable; coverage is narrower because `bash`/external writes require VCS discovery. If repository detection itself fails, candidate collection fails closed. [tag:simplify_missing_vcs_silent_fallback]

## Mode Resolution

Mode resolution is:

1. Default: `yes`
2. Global config: `~/.pi/agent/simplify-code.json`
3. Project config: `<cwd>/.pi/extensions/simplify-code.json`

Project config takes precedence over global config.

## Architecture

```text
Extension (src/index.ts)
  ↓
Tracks successful file-changing tool results and dirty VCS paths
  ↓
At agent_end, sends plain-language simplify request with changed paths
  ↓
Agent commits current changes, inspects touched code, and applies safe simplifications
```

## Notes

- Auto-trigger works by leaning on model judgment, not by expanding a prompt template.
- `/simplify-code yes|no|ask` commands only configure auto-trigger mode.
- `/simplify-code wc` runs a manual working-copy simplify pass and ignores auto-trigger mode.
- Auto-trigger follow-up asks the agent to commit current changes before simplifying, so review stays easy.
- Auto-trigger path scope includes all current dirty VCS code paths, not only newly dirtied paths. [ref:simplify_path_scope_all_dirty]
- Git-ignored paths are excluded from trigger decisions, confirmation dialogs, and follow-up path lists when Git ignore detection is available. [ref:simplify_exclude_gitignored_paths]
- A confirmed non-repository cwd falls back to confirmed tool-result paths; repository-detection failures fail closed. [ref:simplify_missing_vcs_silent_fallback]
