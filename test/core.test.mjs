import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeCommand, buildPrompt, discoverAgentsMd, prepareAgentsContext, safeName, stripAnsi } from "../src/core.mjs";

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

test("stripAnsi removes common escape sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\rnext"), "red\nnext");
});
