#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readPiToolResponse, writePiToolRequest } from "../src/core.mjs";

function parseArgs(argv) {
  const opts = { arguments: {} };
  const first = argv[0];
  opts.command = first && !first.startsWith("--") ? first : "call";
  const rest = opts.command === first ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--home") opts.home = rest[++i];
    else if (arg === "--job") opts.jobId = rest[++i];
    else if (arg === "--id") opts.id = rest[++i];
    else if (arg === "--tool") opts.toolName = rest[++i];
    else if (arg === "--args-json") opts.arguments = JSON.parse(rest[++i]);
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(rest[++i]);
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

function waitForResponse(opts) {
  const timeoutMs = Number(opts.timeoutMs ?? process.env.CCMUX_PI_TOOL_TIMEOUT_MS ?? 10 * 60 * 1000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = readPiToolResponse(opts.jobId, opts.id, opts.home);
    if (response) return response;
    sleep(250);
  }
  throw new Error(`Timed out waiting for Pi tool response for request ${opts.id}`);
}

function makeWaitCommand(request, opts) {
  const args = [
    process.execPath,
    process.argv[1],
    "wait",
    "--job", request.jobId,
    "--id", request.id,
  ];
  if (opts.home) args.push("--home", opts.home);
  if (opts.timeoutMs) args.push("--timeout-ms", String(opts.timeoutMs));
  return args.map((arg) => `'${String(arg).replace(/'/g, `'"'"'`)}'`).join(" ");
}

function createRequest(opts) {
  if (!opts.jobId || !opts.toolName) {
    throw new Error("request requires --job <job-id> and --tool <pi-tool-name>");
  }
  const request = writePiToolRequest({
    jobId: opts.jobId,
    id: opts.id || randomUUID(),
    toolName: opts.toolName,
    arguments: opts.arguments,
    timeoutMs: opts.timeoutMs,
  }, opts.home);
  return {
    ok: true,
    requestId: request.id,
    jobId: request.jobId,
    toolName: request.toolName,
    waitCommand: makeWaitCommand(request, opts),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === "request") {
    process.stdout.write(JSON.stringify(createRequest(opts), null, 2));
    return;
  }

  if (opts.command === "wait") {
    if (!opts.jobId || !opts.id) throw new Error("wait requires --job <job-id> and --id <request-id>");
    const response = waitForResponse(opts);
    process.stdout.write(formatResponse(response));
    process.exit(response.isError ? 1 : 0);
  }

  if (opts.command === "call") {
    const request = createRequest(opts);
    const response = waitForResponse({ ...opts, id: request.requestId });
    process.stdout.write(formatResponse(response));
    process.exit(response.isError ? 1 : 0);
  }

  throw new Error(`Unknown command: ${opts.command}`);
}

try {
  main();
} catch (error) {
  console.error(error?.stack || String(error));
  process.exit(1);
}
