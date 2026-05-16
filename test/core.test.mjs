import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildClaudeCommand,
  buildHookCommand,
  buildPrompt,
  discoverAgentsMd,
  extractJobIdFromText,
  prepareAgentsContext,
  prepareHookSettings,
  readHookEvents,
  recordHookEvent,
  safeName,
  stripAnsi,
} from "../src/core.mjs";

test("safeName keeps tmux-safe names", () => {
  assert.equal(safeName("hello world/repo"), "hello-world-repo");
  assert.equal(safeName("***"), "default");
});

test("buildPrompt appends completion protocol", () => {
  const prompt = buildPrompt({ task: "Do thing", id: "abc", marker: "CCMUX_DONE:abc", donePath: "/tmp/done.json" });
  assert.match(prompt, /Do thing/);
  assert.match(prompt, /CCMUX_DONE:/);
  assert.doesNotMatch(prompt, /CCMUX_DONE:abc/);
  assert.match(prompt, /\/tmp\/done\.json/);
  assert.match(prompt, /final_response/);
  assert.match(prompt, /If you used tools or changed files/);
});

test("buildPrompt can require done JSON for provider mode", () => {
  const prompt = buildPrompt({ task: "Answer", id: "abc", marker: "CCMUX_DONE:abc", donePath: "/tmp/done.json", requireDoneFile: true });
  assert.match(prompt, /Before the final response, create this JSON file/);
  assert.doesNotMatch(prompt, /If you used tools or changed files/);
});

test("buildClaudeCommand defaults to Opus, high effort, and dangerous skip permissions", () => {
  const command = buildClaudeCommand({ name: "demo" });
  assert.match(command, /'--model' 'opus'/);
  assert.match(command, /'--effort' 'high'/);
  assert.match(command, /'--dangerously-skip-permissions'/);
  assert.doesNotMatch(buildClaudeCommand({ dangerouslySkipPermissions: false }), /dangerously-skip-permissions/);
});

test("discoverAgentsMd walks from parent to child and prepareAgentsContext writes prompt file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccmux-test-"));
  const home = path.join(root, "home");
  const child = path.join(root, "repo", "nested");
  mkdirSync(child, { recursive: true });
  mkdirSync(home, { recursive: true });
  const parentAgents = path.join(root, "repo", "AGENTS.md");
  const childAgents = path.join(child, "AGENTS.md");
  writeFileSync(parentAgents, "parent instructions");
  writeFileSync(childAgents, "child instructions");

  try {
    assert.deepEqual(discoverAgentsMd(child), [parentAgents, childAgents]);
    assert.deepEqual(discoverAgentsMd(child, { agentsMd: "AGENTS.md" }), [childAgents]);
    const context = prepareAgentsContext({ cwd: child, home, name: "demo" });
    assert.deepEqual(context.files, [parentAgents, childAgents]);
    const prompt = readFileSync(context.promptPath, "utf8");
    assert.match(prompt, /parent instructions/);
    assert.match(prompt, /child instructions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hook settings include lifecycle and tool hooks", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccmux-hooks-"));
  try {
    const settings = prepareHookSettings({ home: root, name: "demo", hookCommand: "/tmp/fake-hook.mjs" });
    assert.ok(existsSync(settings.settingsPath));
    assert.match(buildHookCommand({ home: root, hookCommand: "/tmp/fake-hook.mjs" }), /fake-hook\.mjs/);
    const parsed = JSON.parse(readFileSync(settings.settingsPath, "utf8"));
    assert.ok(parsed.hooks.SessionStart);
    assert.ok(parsed.hooks.UserPromptSubmit);
    assert.ok(parsed.hooks.PreToolUse);
    assert.ok(parsed.hooks.PostToolUse);
    assert.ok(parsed.hooks.Stop);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recordHookEvent maps Claude hook session ids to ccmux job ids", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ccmux-events-"));
  const jobId = "11111111-1111-4111-8111-111111111111";
  try {
    assert.equal(extractJobIdFromText(`This request is controlled by ccmux job ${jobId}.`), jobId);
    recordHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "claude-session", prompt: `ccmux job ${jobId}` }, { home: root });
    recordHookEvent({ hook_event_name: "PreToolUse", session_id: "claude-session", tool_name: "Bash", tool_input: { command: "npm test" } }, { home: root });
    recordHookEvent({ hook_event_name: "PostToolUse", session_id: "claude-session", tool_name: "Bash", tool_response: { success: true } }, { home: root });
    const { events } = readHookEvents(jobId, { home: root });
    assert.deepEqual(events.map((event) => event.hookEventName), ["UserPromptSubmit", "PreToolUse", "PostToolUse"]);
    assert.equal(events[1].toolName, "Bash");
    assert.equal(events[1].toolInput.command, "npm test");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stripAnsi removes common escape sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\rnext"), "red\nnext");
});
