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

Requirements:

- `tmux` on PATH
- `claude` on PATH
- a normal Claude Code login or configured Claude Code auth
- Pi, if you want the provider or extension tools

### Clean Pi provider setup

Install the package into Pi:

```bash
pi install npm:claude-code-tmux
```

Restart or reload Pi, then pick the provider from `/model`:

```text
claude-code-tmux/opus
```

or:

```text
claude-code-tmux/sonnet
```

You can verify the provider is installed with:

```bash
pi -e npm:claude-code-tmux --list-models claude-code-tmux
```

Then use Pi normally. When Pi calls the provider, `ccmux` starts or reuses an interactive Claude Code session in tmux, relays the turn to it, and returns the final response to Pi.

### CLI install

```bash
npm install -g claude-code-tmux
ccmux --help
```

One-off CLI usage without global install:

```bash
npx -y -p claude-code-tmux ccmux --help
```

Local development:

```bash
git clone https://github.com/Mahir-Isikli/claude-code-tmux.git
cd claude-code-tmux
npm install
npm link
```

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

Install the package into Pi from npm:

```bash
pi install npm:claude-code-tmux
```

For local development, use the checkout path instead:

```bash
pi -e /absolute/path/to/claude-code-tmux --list-models claude-code-tmux
```

The extension registers a native Pi provider:

- provider: `claude-code-tmux`
- models: `opus`, `sonnet`

Select it in Pi with `/model`, or start Pi with model filters that include `claude-code-tmux/*`.

The provider relays Pi model requests into an interactive Claude Code session in tmux. It starts a ccmux session for the current workspace, sends Pi's recent context to Claude Code, streams Claude Code hook lifecycle/tool progress as hidden thinking/progress, and returns Claude Code's final response to Pi. This is still best-effort terminal automation, but it behaves like a normal Pi provider from the model picker.

The extension also registers these tools:

- `ccmux_start`
- `ccmux_send`
- `ccmux_steer`
- `ccmux_status`
- `ccmux_capture`

Provider mode also injects temporary Claude Code hook settings. Hook events are recorded under `~/.pi/ccmux/events/` and can be inspected with:

```bash
ccmux events --session <session-name>
ccmux events --job <job-id>
```

The package also bundles a skill:

- `/skill:claude-code-tmux`

Use the skill when an agent needs the ccmux workflow, CLI fallback commands, AGENTS.md behavior, troubleshooting notes, or public packaging guidance.

Typical tool flow inside Pi:

1. Start a Claude Code session for the repo with `ccmux_start`.
2. The default model is `opus`, the default effort is `high`, and permission prompts are bypassed.
3. Send a task with `ccmux_send`.
4. If the task runs long, use `ccmux_capture` or attach to the tmux session.
5. Use `ccmux_steer` for corrections while Claude Code is running.

Typical provider flow inside Pi:

1. Install with `pi install npm:claude-code-tmux`.
2. Select `claude-code-tmux/opus` from `/model`.
3. Send a normal Pi prompt.
4. Pi calls the provider, which relays the turn into Claude Code running in tmux.

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

## Testing

Fast unit checks:

```bash
npm run check
```

Full local provider matrix. This starts real Claude Code tmux sessions and can take a few minutes:

```bash
npm run test:provider
```

Published npm matrix, useful after a release:

```bash
npm run test:provider:npm
```

The provider matrix covers:

- provider registration
- fresh workspace trust prompt handling
- reused provider sessions
- file edits through Claude Code
- `AGENTS.md` import
- `opus` and `sonnet` provider models
- hook event recording through `ccmux events`

## Remote Control

`ccmux start --remote-control` passes `--remote-control` to Claude Code. That makes the session visible to Claude Code Remote Control if your Claude account supports it. `ccmux` itself still controls the local terminal through tmux.

## Safety and policy notes

This package is a terminal automation layer around the official interactive Claude Code CLI. It is not a hidden API client and does not impersonate a third-party integration. Users should only run it with Claude Code installations and accounts they are allowed to use. For public distribution, avoid language about bypassing billing or access controls.

## Current limitations

- Terminal completion detection is heuristic.
- `ccmux` starts Claude Code with `--dangerously-skip-permissions` by default. Use `--safe-permissions` if you want Claude Code prompts.
- The Pi provider is best-effort terminal automation behind a normal provider entry.
- Claude Code uses its own tools inside tmux, so Pi does not receive structured Pi tool calls from this provider.
- File edits can happen through Claude Code, outside Pi's normal tool transcript.
- Streaming is currently final-response oriented. Use `ccmux_capture` or `ccmux capture` for terminal inspection.
