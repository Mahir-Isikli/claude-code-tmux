#!/usr/bin/env node
import { recordHookEvent } from "../src/core.mjs";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--home") opts.home = argv[++i];
  }
  return opts;
}

async function readStdin() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  recordHookEvent(payload, { home: opts.home });
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
}

main().catch((error) => {
  try {
    process.stderr.write(error?.stack || String(error));
  } catch {}
  process.exit(1);
});
