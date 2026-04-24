# Simplify-Code Extension

<p align="center">
  <img src="images/banner.png" alt="pi-simplify-code hero banner" width="100%">
</p>

Auto-simplifies after non-markdown code changes by tracking changed files, sending a short follow-up message, and leaning on smart models to review and clean up touched code.

## Install

```bash
# Install globally
pi install git:github.com/vedang/pi-simplify-code

# Or install for just the current project
pi install -l git:github.com/vedang/pi-simplify-code
```

## Features

- **Agent-Native Auto-Trigger**: Sends a lightweight follow-up instead of stuffing a long prompt into extension-generated messages
- **Changed-Path Context**: Tells agent exactly which files changed
- **Project Standards**: Lets agent pick up repo conventions from `AGENTS.md` and surrounding code
- **Smart Detection**: Skips markdown-only changes
- **Manual Trigger**: Use `/simplify-code` yourself anytime

## How It Works

### Extension Behavior

The extension tracks file changes during an agent session:

1. **Path Tracking**: Every time `write`, `edit`, or `apply_patch` tools are called, the extension records modified file paths.
2. **Auto-Trigger Check**: At `agent_end`, the extension checks:
   - whether any files were modified
   - whether any non-markdown files were modified (`.md`, `.mdx`, `.markdown` are skipped)
   - whether trigger came from extension itself (to avoid loops)
3. **Follow-up Message**: If checks pass, extension sends a follow-up like:
   ```
   /simplify-code First commit the current changes, then simplify. This makes it easy to review the changes manually after you are done

   The following code paths have changed:
     - src/api/client.ts
     - src/utils/helpers.ts
     - tests/example.test.ts
   ```

### Why This Works

This is core idea behind extension:

- Extension-generated follow-up is **not** expanded into `prompts/simplify-code.md`.
- Instead, extension gives model minimal but high-signal context: “simplify” + changed paths.
- Frontier models are usually smart enough to infer they should inspect touched code, preserve behavior, and clean it up.
- That model inference is whole point of extension. It leans into agent judgment instead of micromanaging simplification with a giant prompt every time.

## Prompt Template and Manual Use

`prompts/simplify-code.md` still matters, but in different path:

- Manual `/simplify-code [context]` can use prompt-template guidance.
- Auto-triggered follow-up from extension does **not** depend on that prompt being expanded.
- Editing `prompts/simplify-code.md` mainly affects manual use and any environment where `/simplify-code` is expanded from normal user input.

## Commands

### `/simplify-code [context]`

Manually trigger simplification with optional context:

```bash
/simplify-code
/simplify-code Focus on auth module
/simplify-code The following files need review: src/auth.ts src/session.ts
```

Use this when you want to explicitly ask for a simplify pass yourself.
If your setup expands slash prompts for normal user input, `prompts/simplify-code.md` provides that guidance.
This is separate from extension auto-trigger behavior.

### `/simplify-code yes|no|ask`

Control auto-trigger behavior (global scope, legacy behavior):

| Command | Behavior |
|---------|----------|
| `/simplify-code yes` | Always auto-trigger after code changes (default) |
| `/simplify-code no` | Never auto-trigger |
| `/simplify-code ask` | Show a YES/NO dialog before triggering |

The setting persists globally in `~/.pi/agent/simplify-code.json`.

### `/simplify-code global yes|no|ask`

Explicitly set global mode. Writes to `~/.pi/agent/simplify-code.json`.

### `/simplify-code project yes|no|ask`

Explicitly set project-mode. Writes to `<cwd>/.pi/extensions/simplify-code.json` using the current session cwd.

The project value overrides global mode for matching sessions.

## What It Does

 The prompt template refines code to improve:
 - **Clarity**: Reduces unnecessary complexity and nesting
 - **Consistency**: Applies project-wide coding standards
 - **Maintainability**: Improves variable/function names and structure
 - **Balance**: Avoids over-simplification that harms readability

## Auto-Trigger Behavior

Extension automatically sends simplify follow-up at `agent_end` when:

1. At least one file was modified
2. At least one non-markdown file was modified (`.md`, `.mdx`, `.markdown` are skipped)
3. Trigger did not come from extension itself (prevents loops)
4. Mode is not set to `no` (see [Configuration](#configuration))

Follow-up contains:

- `/simplify-code`
- instruction to commit current changes, then simplify
- list of changed paths

In `ask` mode, a confirmation dialog appears listing changed files with YES/NO buttons before sending follow-up.

## Configuration

### Auto-Trigger Mode

Mode resolution is:

1. Default: `yes`
2. Global config: `~/.pi/agent/simplify-code.json`
3. Project config: `<cwd>/.pi/extensions/simplify-code.json`

This uses the session's current cwd for the project config path and applies project config over global config.

Use `/simplify-code global yes|no|ask` for global scope and `/simplify-code project yes|no|ask` for project scope.

### Prompt Customization

Customize `prompts/simplify-code.md` if you want to shape **manual** `/simplify-code` guidance:

- adjust refinement priorities
- add project-specific rules
- change balance between simplicity and clarity

This file does **not** power extension auto-trigger by being expanded into follow-up message.
Auto-trigger works because model understands follow-up request plus changed-path context.

## Architecture

### Auto-Trigger Path

```
Extension (src/index.ts)
  ↓
Tracks file changes via tool_call events
  ↓
At agent_end, sends short follow-up with simplify request + changed paths
  ↓
Model inspects touched code and decides how to simplify it
```

### Manual Path

```
User runs /simplify-code [context]
  ↓
Prompt Template (prompts/simplify-code.md)
  ↓
Model simplifies code using explicit prompt-template guidance
```

## Notes

- Skips markdown-only changes ([ref:simplify_code_skip_markdown_only])
- Auto-trigger works by leaning on model intelligence, not by expanding prompt template inside extension follow-up
- `/simplify-code yes|no|ask` are extension control commands for auto-trigger mode
- Auto-trigger mode is stored in `~/.pi/agent/simplify-code.json`
- Auto-trigger follow-up asks agent to commit current changes before simplify pass so review stays easy
- Auto-trigger mode is stored in `~/.pi/agent/simplify-code.json` (global)
- Project override is stored in `<cwd>/.pi/extensions/simplify-code.json`
