# claude-code-tmux

Durable tmux control for interactive Claude Code sessions, plus a Pi extension that can delegate work to those sessions.

This does not call Claude Code `--print` and it does not use the Anthropic API directly. It starts the official `claude` interactive CLI inside tmux, pastes tasks into that terminal, captures logs, and optionally waits for a completion marker.

## Why

If non-interactive Claude Code usage becomes a paid programmatic path, a local agent can still coordinate the interactive Claude Code app you are already logged into. `ccmux` makes that setup durable and scriptable:

- Claude Code keeps running in tmux if the parent agent dies.
- Any process can attach, steer, or inspect the session.
- Pi can call Claude Code as a delegated subagent via tools.
- The package can be installed from npm or GitHub as a Pi package.

## Install

Local development:

```bash
git clone https://github.com/your-name/claude-code-tmux.git
cd claude-code-tmux
npm install
npm link
```

Later, after publishing:

```bash
npm install -g claude-code-tmux
pi install npm:claude-code-tmux
```

Requirements:

- `tmux` on PATH
- `claude` on PATH
- A normal Claude Code login or configured Claude Code auth

## CLI usage

Start a session:

```bash
ccmux start --name demo --cwd .
```

By default, `ccmux start` launches Claude Code with:

```bash
claude --model opus --effort high --dangerously-skip-permissions
```

Claude Code resolves `opus` to the latest Opus model, currently Opus 4.7. You can override model and effort:

```bash
ccmux start --name demo --cwd . --model sonnet --effort xhigh
ccmux start --name demo --cwd . --model claude-opus-4-7 --effort max
```

For a safer interactive session, opt out of bypass mode:

```bash
ccmux start --name demo --cwd . --safe-permissions
```

Send work and wait for the completion protocol:

```bash
ccmux send --session demo --wait "Inspect this repo and summarize the architecture."
```

Send live steering:

```bash
ccmux steer --session demo "Keep the scope tiny and do not edit files yet."
```

Inspect or attach:

```bash
ccmux status
ccmux capture --session demo --lines 120
tmux attach -t ccmux-demo
```

Kill a session:

```bash
ccmux kill --session demo
```

## Pi usage

Install the package into Pi:

```bash
pi install /absolute/path/to/claude-code-tmux
```

The extension registers these tools:

- `ccmux_start`
- `ccmux_send`
- `ccmux_steer`
- `ccmux_status`
- `ccmux_capture`

Typical flow inside Pi:

1. Start a Claude Code session for the repo with `ccmux_start`.
2. The default model is `opus`, the default effort is `high`, and permission prompts are bypassed.
3. Send a task with `ccmux_send`.
4. If the task runs long, use `ccmux_capture` or attach to the tmux session.
5. Use `ccmux_steer` for corrections while Claude Code is running.

## AGENTS.md support

Claude Code already reads `CLAUDE.md`. Many agent projects use `AGENTS.md` instead. On start, `ccmux` auto-discovers `AGENTS.md` files from the working directory upward to your home directory, combines them, and passes them to Claude Code with `--append-system-prompt-file`.

This means users do not need to symlink `AGENTS.md` to `CLAUDE.md`. If both files exist, Claude Code sees its normal `CLAUDE.md` context plus the imported `AGENTS.md` instructions.

Disable this behavior if needed:

```bash
ccmux start --name demo --cwd . --no-agents-md
```

Use an explicit file if you want:

```bash
ccmux start --name demo --cwd . --agents-md ./AGENTS.md
```

## Completion detection

For each sent task, `ccmux` appends a protocol asking Claude Code to include:

```text
CCMUX_DONE:<job-id>
```

It also asks Claude Code to write a JSON done file under `.ccmux/jobs/` in the target workspace. The runner treats either the marker or the done file as completion.

This is intentionally best-effort. Interactive terminal UIs are not stable APIs. If the marker is not seen, the tmux session may still have completed. Use `ccmux capture` or attach to check.

## Remote Control

`ccmux start --remote-control` passes `--remote-control` to Claude Code. That makes the session visible to Claude Code Remote Control if your Claude account supports it. `ccmux` itself still controls the local terminal through tmux.

## Safety and policy notes

This package is a terminal automation layer around the official interactive Claude Code CLI. It is not a hidden API client and does not impersonate a third-party integration. Users should only run it with Claude Code installations and accounts they are allowed to use. For public distribution, avoid language about bypassing billing or access controls.

## Current limitations

- Terminal completion detection is heuristic.
- `ccmux` starts Claude Code with `--dangerously-skip-permissions` by default. Use `--safe-permissions` if you want Claude Code prompts.
- It is not a Pi model provider. In Pi, it is a subagent tool that can edit files through Claude Code.
- Streaming is based on terminal capture, not structured Claude Code events.
