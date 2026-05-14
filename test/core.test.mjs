import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, safeName, stripAnsi } from "../src/core.mjs";

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
});

test("stripAnsi removes common escape sequences", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m\rnext"), "red\nnext");
});
