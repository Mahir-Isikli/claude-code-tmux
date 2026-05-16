#!/usr/bin/env node
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const keep = args.has("--keep");
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const version = process.env.CCMUX_TEST_VERSION || pkg.version;
const packageSpec = local ? repoRoot : `npm:claude-code-tmux@${version}`;
const npxPackage = local ? repoRoot : `claude-code-tmux@${version}`;
const root = mkdtempSync(path.join(os.tmpdir(), "ccmux-provider-matrix-"));

function run(command, options = {}) {
  return execSync(command, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeout ?? 10 * 60 * 1000,
  });
}

function clean(text) {
  return String(text || "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")
    .trim();
}

function assertIncludes(label, text, expected) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}. Got:\n${text}`);
  }
}

function pi(args, timeout = 10 * 60 * 1000) {
  return run(`pi -e ${shell(packageSpec)} ${args} 2>&1`, { timeout });
}

function shell(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function ccmux(args) {
  if (local) return run(`node ${shell(path.join(repoRoot, "bin", "ccmux.mjs"))} ${args}`);
  return run(`npx -y -p ${shell(npxPackage)} ccmux ${args}`);
}

function cleanup() {
  try {
    const status = JSON.parse(ccmux("status"));
    for (const session of status.sessions || []) {
      if (String(session.cwd || "").includes(path.basename(root))) {
        try { ccmux(`kill --session ${shell(session.name)}`); } catch {}
      }
    }
  } catch {}
  if (!keep) rmSync(root, { recursive: true, force: true });
}

try {
  writeFileSync(path.join(root, "README.md"), "# ccmux provider matrix\n");
  writeFileSync(path.join(root, "AGENTS.md"), [
    "# ccmux matrix AGENTS.md",
    "",
    "For this workspace only, when the user asks for the AGENTS_CHECK phrase, reply exactly:",
    "",
    "agents import works",
    "",
  ].join("\n"));

  console.log("1 model registration");
  const models = pi("--list-models claude-code-tmux", 2 * 60 * 1000);
  assertIncludes("models", models, "claude-code-tmux  opus");
  assertIncludes("models", models, "claude-code-tmux  sonnet");

  console.log("2 fresh provider call");
  const fresh = clean(pi("--model claude-code-tmux/opus --thinking low -p 'Reply with exactly: fresh provider ok'"));
  console.log(fresh);
  assertIncludes("fresh", fresh, "fresh provider ok");

  console.log("3 reused provider call");
  const reused = clean(pi("--model claude-code-tmux/opus --thinking low -p 'Reply with exactly: reused provider ok'"));
  console.log(reused);
  assertIncludes("reused", reused, "reused provider ok");

  console.log("4 file edit provider call");
  const file = clean(pi("--model claude-code-tmux/opus --thinking low -p 'Create a file named matrix-provider-file.txt in the current directory containing exactly this single line: matrix file edit ok. Then reply exactly: matrix file done'"));
  console.log(file);
  assertIncludes("file", file, "matrix file done");
  const fileContent = readFileSync(path.join(root, "matrix-provider-file.txt"), "utf8").trim();
  if (fileContent !== "matrix file edit ok") throw new Error(`Unexpected file content: ${fileContent}`);

  console.log("5 native Pi tool bridge");
  const nativePi = clean(pi("--model claude-code-tmux/opus --thinking low -p 'Use the Pi native tool bridge command from your instructions to call the Pi read tool on README.md. Do not use Claude Code local Read. After the bridge returns, reply exactly: native pi read ok'"));
  console.log(nativePi);
  assertIncludes("native-pi", nativePi, "native pi read ok");

  console.log("6 AGENTS.md import");
  const agents = clean(pi("--model claude-code-tmux/opus --thinking low -p 'What is the AGENTS_CHECK phrase? Reply exactly with the phrase from local AGENTS.md and nothing else.'"));
  console.log(agents);
  assertIncludes("agents", agents, "agents import works");

  console.log("7 sonnet provider call");
  const sonnet = clean(pi("--model claude-code-tmux/sonnet --thinking low -p 'Reply with exactly: sonnet provider ok'"));
  console.log(sonnet);
  assertIncludes("sonnet", sonnet, "sonnet provider ok");

  console.log("8 hook events, native Pi tool, and shadow replay recorded");
  const status = JSON.parse(ccmux("status"));
  const matrixJobs = (status.jobs || []).filter((job) => String(job.cwd || "").includes(path.basename(root)));
  if (matrixJobs.length < 5) throw new Error(`Expected at least 5 matrix jobs, got ${matrixJobs.length}`);
  const eventfulJobs = [];
  const replayJobs = [];
  const nativeToolJobs = [];
  for (const job of matrixJobs) {
    const result = JSON.parse(ccmux(`events --job ${shell(job.id)}`));
    const events = result.events || [];
    if (events.some((event) => event.hookEventName === "UserPromptSubmit") && events.some((event) => event.hookEventName === "Stop")) {
      eventfulJobs.push(job);
    }
    if (events.some((event) => event.hookEventName === "PiReplayToolResult")) {
      replayJobs.push(job);
    }
    if (events.some((event) => event.hookEventName === "PiNativeToolRequest") && events.some((event) => event.hookEventName === "PiNativeToolResult")) {
      nativeToolJobs.push(job);
    }
  }
  if (eventfulJobs.length < 3) throw new Error(`Expected hook events on at least 3 jobs, got ${eventfulJobs.length}`);
  if (replayJobs.length < 1) throw new Error("Expected at least one PiReplayToolResult event from shadow replay");
  if (nativeToolJobs.length < 1) throw new Error("Expected at least one Pi native tool request/result pair");

  console.log("MATRIX_OK");
} finally {
  cleanup();
}
