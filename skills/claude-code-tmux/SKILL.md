---
name: claude-code-tmux
description: >-
  Use ccmux to run and steer durable interactive Claude Code sessions inside tmux. Use when the user mentions Claude Code tmux, ccmux, delegating work to Claude Code without print mode, live steering, Remote Control, AGENTS.md import, or installing the claude-code-tmux npm or Pi package.
---

# Claude Code tmux

Use this skill when you need to delegate work to interactive Claude Code through `ccmux`, inspect a running Claude Code tmux session, steer it while it works, or explain how users should install and reuse the package.

## Mental model

`ccmux` is a terminal automation layer around the official interactive `claude` CLI:

- It starts `claude` in a durable tmux session.
- It pastes prompts into that interactive terminal.
- It captures terminal logs and waits for a best-effort completion protocol.
- It can be used directly as a CLI, through Pi extension tools, or as a Pi provider.
- The Pi provider is best-effort terminal automation behind a normal provider entry, not a hidden API client.

Default start behavior:

```bash
claude --model opus --effort high --dangerously-skip-permissions
```

Claude Code resolves `opus` to the latest Opus model. The user can override model and effort.

## Native Pi provider

If the package extension is loaded, Pi registers:

- provider: `claude-code-tmux`
- models: `opus`, `sonnet`

Use the provider when the user wants Pi itself to run on the tmux-backed Claude Code bridge. Select `claude-code-tmux/opus` from `/model` or ask the user to choose it. The provider sends Pi's recent context into a durable Claude Code tmux session, records Claude Code hook lifecycle/tool events, streams those events as progress, and returns the final response to Pi.

Provider limitations:

- It cannot emit structured Pi tool calls. Claude Code uses its own tools inside tmux.
- File edits can happen through Claude Code, outside Pi's normal tool transcript.
- Final answer text still comes from done JSON. Hook events are progress and observability, not perfect token streaming.
- If it times out, inspect with `ccmux_capture`, `ccmux capture`, or `ccmux events --session <name>`.

## Prefer Pi tools for explicit delegation

If the package extension is loaded and the user wants delegation rather than selecting a model provider, prefer the Pi tools over shelling out:

1. `ccmux_status` to inspect existing sessions and jobs.
2. `ccmux_start` to start or reuse a session for the workspace.
3. `ccmux_send` to delegate a task.
4. `ccmux_capture` when a job times out or you need to see the terminal.
5. `ccmux_steer` to send live corrections while Claude Code is running.

Use short, explicit task prompts. Include the workspace, target files, validation command, and constraints. Let `ccmux_send` append its completion protocol unless you have a specific reason to disable it.

## CLI fallback

If Pi tools are not active, use the CLI. From this skill directory, the package-local CLI is:

```bash
node ../../bin/ccmux.mjs --help
```

If the package bin is on `PATH`, use `ccmux` directly:

```bash
ccmux start --name demo --cwd .
ccmux send --session demo --wait "Inspect this repo and summarize it."
ccmux capture --session demo --lines 120
ccmux steer --session demo "Keep the scope small and avoid broad refactors."
```

Common start variants:

```bash
ccmux start --name demo --cwd . --model sonnet --effort xhigh
ccmux start --name demo --cwd . --model claude-opus-4-7 --effort max
ccmux start --name demo --cwd . --safe-permissions
ccmux start --name demo --cwd . --remote-control
```

Use `--safe-permissions` only when the user wants Claude Code permission prompts instead of the default bypass mode.

## AGENTS.md behavior

Claude Code already reads `CLAUDE.md`. `ccmux` also imports `AGENTS.md` instructions:

- It searches from the target cwd up to the home directory.
- It combines discovered `AGENTS.md` files into `~/.pi/ccmux/instructions/<session>.agents.md`.
- It passes that file to Claude Code with `--append-system-prompt-file`.

This avoids needing to symlink `AGENTS.md` to `CLAUDE.md`.

Disable automatic import:

```bash
ccmux start --name demo --cwd . --no-agents-md
```

Use an explicit file:

```bash
ccmux start --name demo --cwd . --agents-md ./AGENTS.md
```

## Testing workflow

Use the bundled test suite before claiming provider changes work:

```bash
npm run check
npm run test:ci
npm run test:provider
```

After publishing, test the npm package too:

```bash
npm run test:provider:npm
```

The deterministic CI suite checks packaging, CLIs, hook recording, and the Pi tool request broker without Claude auth. The provider matrix checks fresh workspaces, reused sessions, file edits, native Pi tool calls, AGENTS.md import, opus, sonnet, hook event recording, and shadow replay.

## Robust workflow

1. Check current state:

```bash
ccmux status
```

2. Start a named session for the repo if needed:

```bash
ccmux start --name <short-name> --cwd <repo-path>
```

3. Send a bounded task:

```bash
ccmux send --session <short-name> --wait --timeout-ms 600000 "<task>"
```

4. If the job times out, do not assume failure. Capture the terminal:

```bash
ccmux capture --session <short-name> --lines 160
```

5. If Claude Code is blocked, attach manually or steer it:

```bash
tmux attach -t ccmux-<short-name>
ccmux steer --session <short-name> "Use the existing test command and finish with the ccmux marker."
```

6. After file-changing work, validate with normal repo commands from the controlling agent too. Do not rely only on Claude Code's final summary.

## Public packaging guidance

When writing docs, READMEs, npm descriptions, or GitHub copy for this project:

- Describe it as durable tmux control for interactive Claude Code.
- Say it helps agents coordinate a local interactive Claude Code session.
- Do not frame it as bypassing billing, rate limits, product restrictions, or access controls.
- Mention requirements clearly: `tmux`, `claude` on PATH, and a valid Claude Code setup.
- Keep the distinction clear: CLI, Pi extension tools, and a best-effort native Pi provider.

## Troubleshooting

- **No session found:** run `ccmux status`, then `ccmux start --name ... --cwd ...`.
- **Job timed out:** use `ccmux capture`; Claude Code may still be running or done without the marker.
- **Permission or trust prompt:** attach with `tmux attach -t ccmux-<name>`, or restart with default bypass mode if appropriate.
- **Wrong model:** restart the session with `--model <model>` and verify the returned session JSON.
- **AGENTS.md did not load:** check `agentsFiles` and `agentsPromptPath` in `ccmux start` or `ccmux status` output.
