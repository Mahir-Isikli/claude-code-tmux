#!/usr/bin/env node
import { readPiToolResponse, writePiToolRequest } from "../src/core.mjs";

function parseArgs(argv) {
  const opts = { arguments: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home") opts.home = argv[++i];
    else if (arg === "--job") opts.jobId = argv[++i];
    else if (arg === "--id") opts.id = argv[++i];
    else if (arg === "--tool") opts.toolName = argv[++i];
    else if (arg === "--args-json") opts.arguments = JSON.parse(argv[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(argv[++i]);
  }
  return opts;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function formatResponse(response) {
  if (response?.isError) {
    return JSON.stringify({ ok: false, error: response.content || response.error || "Pi tool failed", details: response.details ?? null }, null, 2);
  }
  return JSON.stringify({ ok: true, content: response.content ?? [], details: response.details ?? null }, null, 2);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.jobId || !opts.toolName) {
    console.error("Usage: ccmux-pi-tool --job <job-id> --tool <pi-tool-name> --args-json '<json>'");
    process.exit(2);
  }

  const request = writePiToolRequest({
    jobId: opts.jobId,
    id: opts.id,
    toolName: opts.toolName,
    arguments: opts.arguments,
    timeoutMs: opts.timeoutMs,
  }, opts.home);

  const timeoutMs = Number(opts.timeoutMs ?? process.env.CCMUX_PI_TOOL_TIMEOUT_MS ?? 10 * 60 * 1000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = readPiToolResponse(request.jobId, request.id, opts.home);
    if (response) {
      process.stdout.write(formatResponse(response));
      process.exit(response.isError ? 1 : 0);
    }
    sleep(250);
  }

  console.error(`Timed out waiting for Pi tool response for request ${request.id}`);
  process.exit(1);
}

main();
