# claude-code-tmux agent notes

## What this repo is

`claude-code-tmux` provides durable tmux control for interactive Claude Code sessions.

It ships three integration surfaces:

1. `ccmux` CLI for humans and agents.
2. Pi extension tools: `ccmux_start`, `ccmux_send`, `ccmux_steer`, `ccmux_status`, `ccmux_capture`.
3. Native Pi provider: `claude-code-tmux/opus` and `claude-code-tmux/sonnet`.

The package is published on npm and GitHub:

- npm: `claude-code-tmux`
- GitHub: `https://github.com/Mahir-Isikli/claude-code-tmux`

## Current working release

As of the hook-backed provider work, the working npm release is `0.3.0`.

Important fixes in `0.2.1`:

- Auto-detect and accept Claude Code workspace trust prompts in provider mode.
- Wait for Claude Code to be ready before sending the first provider prompt.
- Verify the pasted job id is visible in the tmux pane before submitting.
- Retry paste if tmux drops it.
- Submit with `C-m` instead of literal `Enter`.
- Provider mode requires a done JSON with `final_response` and returns that to Pi.

Important additions in `0.3.0`:

- Generated Claude Code hook settings per ccmux session.
- `bin/ccmux-hook.mjs` command hook recorder.
- Hook events stored under `~/.pi/ccmux/events/<job-id>.jsonl`.
- `ccmux events --job <job-id>` and `ccmux events --session <name>` for inspection.
- Provider mode starts Claude Code with hooks enabled.
- Provider streams hook lifecycle/tool progress as thinking/progress deltas while preserving the final response text.
- Provider matrix script under `scripts/provider-matrix.mjs`.

## Design constraints

- This is terminal automation around the official interactive `claude` CLI.
- Do not describe it as a billing, access-control, or product restriction bypass.
- The Pi provider is best-effort terminal automation behind a normal provider entry.
- Claude Code uses its own tools inside tmux, so Pi does not receive structured Pi tool calls from the provider.
- File edits may happen through Claude Code, outside Pi's normal tool transcript.
- Keep the CLI, Pi tools, provider, and bundled skill all working together.

## Validation commands

Run these before publishing:

```bash
npm run check
ruby ~/.pi/agent/skills/skill-creator/scripts/validate_skills.rb skills
pi -e . --list-models claude-code-tmux
npm publish --dry-run --access public
```

Provider smoke test from local checkout:

```bash
rm -rf /tmp/ccmux-provider-smoke
mkdir -p /tmp/ccmux-provider-smoke
cd /tmp/ccmux-provider-smoke
printf '# smoke\n' > README.md
pi -e /Users/mahirisikli/Git/Personal/claude-code-tmux \
  --model claude-code-tmux/opus \
  --thinking low \
  -p "Reply with exactly: provider works"
```

Published npm smoke test:

```bash
pi -e npm:claude-code-tmux@0.3.0 --list-models claude-code-tmux
pi -e npm:claude-code-tmux@0.3.0 \
  --model claude-code-tmux/opus \
  --thinking low \
  -p "Reply with exactly: npm provider works"
```

File-edit smoke test:

```bash
rm -rf /tmp/ccmux-provider-filetest
mkdir -p /tmp/ccmux-provider-filetest
cd /tmp/ccmux-provider-filetest
printf '# file test\n' > README.md
pi -e npm:claude-code-tmux@0.3.0 \
  --model claude-code-tmux/opus \
  --thinking low \
  -p "Create a file named provider-native-test.txt in the current directory containing exactly this single line: native provider file edit works. Then reply exactly: file done"
cat provider-native-test.txt
```

Full provider matrix:

```bash
npm run test:provider       # local checkout
npm run test:provider:npm   # published npm version, after publish
```

## Test matrix already run

The published npm package was tested for:

- provider registration from npm
- fresh workspace trust prompt handling
- reused provider session
- file edit through provider
- `AGENTS.md` import through provider
- `claude-code-tmux/opus`
- `claude-code-tmux/sonnet`

The matrix passed on `0.2.1`. Re-run it for every provider release; `0.3.0` adds hook event assertions.

## Release workflow

Use npm patch versions for docs or reliability fixes:

```bash
npm version patch --no-git-tag-version
npm run check
ruby ~/.pi/agent/skills/skill-creator/scripts/validate_skills.rb skills
npm publish --dry-run --access public
git add .
git commit -m "..."
git push
npm publish --access public
git tag vX.Y.Z
git push origin vX.Y.Z
```

After publishing, verify:

```bash
npm dist-tag ls claude-code-tmux
npm view claude-code-tmux version
pi -e npm:claude-code-tmux@X.Y.Z --list-models claude-code-tmux
```

## Troubleshooting

- If a provider call hangs, inspect the tmux pane with `ccmux capture --session <name> --lines 160`.
- If the prompt is sitting in the input box, paste or submit timing regressed.
- If Claude Code is at a workspace trust prompt, provider readiness detection regressed.
- If a job has `doneFile: true` and `markerSeen: false`, it can still be successful because provider mode reads `final_response` from the done JSON.
- Clean test sessions with `ccmux status` and `ccmux kill --session <name>`.
