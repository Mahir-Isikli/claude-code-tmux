#!/usr/bin/env node
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "ccmux-ci-smoke-"));
const keep = process.argv.includes("--keep");

function sh(command, options = {}) {
  return execSync(command, { cwd: options.cwd || repoRoot, encoding: "utf8", stdio: options.stdio || ["ignore", "pipe", "pipe"], env: { ...process.env, ...(options.env || {}) } });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

try {
  console.log("1 package manifest");
  const pkg = readJson(path.join(repoRoot, "package.json"));
  assert(pkg.bin.ccmux === "bin/ccmux.mjs", "ccmux bin missing");
  assert(pkg.bin["claude-code-tmux"] === "bin/ccmux.mjs", "claude-code-tmux bin missing");
  assert(pkg.pi?.extensions?.includes("./extensions/pi.ts"), "pi extension missing");
  assert(pkg.pi?.skills?.includes("./skills"), "pi skills missing");

  console.log("2 skill frontmatter");
  const skill = readFileSync(path.join(repoRoot, "skills", "claude-code-tmux", "SKILL.md"), "utf8");
  assert(/^---\n[\s\S]*?^name: claude-code-tmux$/m.test(skill), "skill name invalid");
  assert(/description: >-/m.test(skill), "skill description missing folded style");

  console.log("3 npm pack contents");
  const packJson = JSON.parse(sh(`npm pack ${repoRoot} --pack-destination ${tmp} --json`));
  const tarball = path.join(tmp, packJson[0].filename);
  const entries = sh(`tar -tzf ${tarball}`, { cwd: tmp }).trim().split("\n");
  for (const required of [
    "package/bin/ccmux.mjs",
    "package/bin/ccmux-hook.mjs",
    "package/bin/ccmux-pi-tool.mjs",
    "package/extensions/pi.ts",
    "package/scripts/provider-matrix.mjs",
    "package/skills/claude-code-tmux/SKILL.md",
    "package/src/core.mjs",
  ]) {
    assert(entries.includes(required), `tarball missing ${required}`);
  }

  console.log("4 extracted package smoke");
  sh(`tar -xzf ${tarball}`, { cwd: tmp });
  const extracted = path.join(tmp, "package");
  const help = execFileSync(process.execPath, [path.join(extracted, "bin", "ccmux.mjs"), "--help"], { encoding: "utf8" });
  assert(help.includes("ccmux: durable tmux controller"), "ccmux help failed");

  console.log("5 core event broker");
  const core = await import(pathToFileURL(path.join(extracted, "src", "core.mjs")));
  const home = path.join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const jobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  core.recordHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: `ccmux job ${jobId}` }, { home });
  core.recordHookEvent({ hook_event_name: "Stop", session_id: "s1" }, { home });
  const events = core.readHookEvents(jobId, { home }).events;
  assert(events.map((event) => event.hookEventName).join(",") === "UserPromptSubmit,Stop", "hook event broker failed");

  console.log("6 hook CLI recorder");
  const hookInput = JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Bash", tool_input: { command: "echo ok" } });
  execFileSync(process.execPath, [path.join(extracted, "bin", "ccmux-hook.mjs"), "--home", home], { input: hookInput, encoding: "utf8" });
  const hookEvents = core.readHookEvents(jobId, { home }).events;
  assert(hookEvents.some((event) => event.hookEventName === "PreToolUse" && event.toolName === "Bash"), "hook CLI did not record event");

  console.log("7 native Pi tool request broker CLI");
  const piTool = spawn(process.execPath, [
    path.join(extracted, "bin", "ccmux-pi-tool.mjs"),
    "--home", home,
    "--job", jobId,
    "--id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "--tool", "read",
    "--args-json", "{\"path\":\"README.md\"}",
    "--timeout-ms", "5000",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const pending = core.listPendingPiToolRequests(jobId, { home });
  assert(pending.length === 1 && pending[0].toolName === "read", "pi tool request was not pending");
  core.writePiToolResponse(jobId, pending[0].id, { content: [{ type: "text", text: "hello" }], details: { ok: true } }, home);
  const { stdout, stderr, code } = await waitProcess(piTool);
  assert(code === 0, `pi tool bridge exited ${code}: ${stderr}`);
  assert(stdout.includes("hello"), "pi tool bridge did not print response");

  console.log("CI_SMOKE_OK");
} finally {
  if (keep) console.log(`Kept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

function waitProcess(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}
