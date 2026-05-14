#!/usr/bin/env node
import {
  CcmuxError,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  captureSession,
  killSession,
  listJobs,
  listSessions,
  safeName,
  sendPrompt,
  startSession,
  steerSession,
  waitForJob,
} from "../src/core.mjs";

const COMMANDS = new Set(["start", "send", "steer", "status", "capture", "jobs", "wait", "attach", "kill", "help"]);

function printHelp() {
  console.log(`ccmux: durable tmux controller for interactive Claude Code

Usage:
  ccmux start [--name NAME] [--cwd DIR] [--model MODEL] [--effort LEVEL] [--remote-control] [--safe-permissions] [--no-agents-md]
  ccmux send [--session NAME] [--wait] [--timeout-ms MS] [--settle-ms MS] "prompt"
  ccmux steer [--session NAME] "message"
  ccmux status
  ccmux capture [--session NAME] [--lines N]
  ccmux jobs
  ccmux wait JOB_ID [--timeout-ms MS] [--settle-ms MS]
  ccmux attach [--session NAME]
  ccmux kill [--session NAME]

Defaults:
  model: ${DEFAULT_MODEL} (Claude Code resolves this to the latest Opus, currently Opus 4.7)
  effort: ${DEFAULT_EFFORT}
  permissions: --dangerously-skip-permissions
  AGENTS.md: auto-imported from parent directories

Examples:
  ccmux start --name demo --cwd .
  ccmux send --session demo --wait "Inspect the repo and summarize it."
  ccmux steer --session demo "Keep the scope small."
  ccmux attach --session demo
`);
}

function parseArgv(argv) {
  const args = [...argv];
  let command = args.shift() || "help";
  const opts = { _: [] };
  if (command === "--help" || command === "-h") {
    command = "help";
    opts.help = true;
  }
  while (args.length) {
    const item = args.shift();
    if (item === "--") {
      opts._.push(...args);
      break;
    }
    if (!item.startsWith("--")) {
      opts._.push(item);
      continue;
    }
    const eq = item.indexOf("=");
    const key = item.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) {
      opts[key] = item.slice(eq + 1);
      continue;
    }
    const next = args[0];
    if (!next || next.startsWith("--")) {
      opts[key] = true;
    } else {
      opts[key] = args.shift();
    }
  }
  return { command, opts };
}

function asBool(value) {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function timeoutFrom(opts) {
  if (opts["timeout-ms"]) return Number(opts["timeout-ms"]);
  if (opts.timeout) return Number(opts.timeout) * 1000;
  return undefined;
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const { command, opts } = parseArgv(process.argv.slice(2));
  if (!COMMANDS.has(command) || command === "help" || opts.help || opts.h) {
    printHelp();
    process.exit(command === "help" || opts.help || opts.h ? 0 : 1);
  }

  if (command === "start") {
    const session = startSession({
      name: opts.name || opts.session || safeName(process.cwd().split("/").pop()),
      cwd: opts.cwd || process.cwd(),
      permissionMode: opts["permission-mode"],
      model: opts.model,
      effort: opts.effort,
      remoteControl: opts["remote-control"] === true ? opts.name || true : opts["remote-control"],
      dangerouslySkipPermissions: !(asBool(opts["safe-permissions"]) || asBool(opts["no-dangerously-skip-permissions"])),
      agentsMd: asBool(opts["no-agents-md"]) ? false : opts["agents-md"] ?? true,
      extraArgs: opts._,
    });
    printJson(session);
    return;
  }

  if (command === "send") {
    const prompt = opts._.join(" ").trim();
    if (!prompt) throw new CcmuxError("send requires a prompt");
    const result = await sendPrompt({
      session: opts.session || opts.name || "default",
      prompt,
      wait: asBool(opts.wait),
      timeoutMs: timeoutFrom(opts),
      settleMs: opts["settle-ms"] ? Number(opts["settle-ms"]) : undefined,
      protocol: opts.protocol !== "false",
    });
    printJson(result);
    return;
  }

  if (command === "steer") {
    const message = opts._.join(" ").trim();
    if (!message) throw new CcmuxError("steer requires a message");
    printJson(steerSession({ session: opts.session || opts.name || "default", message }));
    return;
  }

  if (command === "status") {
    printJson({ sessions: listSessions(), jobs: listJobs().map(({ logTail, ...job }) => job) });
    return;
  }

  if (command === "capture") {
    const result = captureSession(opts.session || opts.name || "default", { lines: opts.lines || 120 });
    process.stdout.write(result.text);
    if (result.error) process.stderr.write(result.error);
    return;
  }

  if (command === "jobs") {
    printJson(listJobs());
    return;
  }

  if (command === "wait") {
    const id = opts._[0];
    if (!id) throw new CcmuxError("wait requires a job id");
    printJson(await waitForJob(id, { timeoutMs: timeoutFrom(opts), settleMs: opts["settle-ms"] ? Number(opts["settle-ms"]) : undefined }));
    return;
  }

  if (command === "attach") {
    const sessions = listSessions();
    const name = opts.session || opts.name || "default";
    const session = sessions.find((s) => s.name === safeName(name));
    if (!session) throw new CcmuxError(`No ccmux session named ${safeName(name)}`);
    console.log(`Run: tmux attach -t ${session.tmuxSession}`);
    return;
  }

  if (command === "kill") {
    printJson(killSession(opts.session || opts.name || "default"));
  }
}

main().catch((error) => {
  if (error instanceof CcmuxError) {
    console.error(error.message);
    if (process.env.CCMUX_DEBUG) console.error(JSON.stringify(error.details, null, 2));
  } else {
    console.error(error?.stack || String(error));
  }
  process.exit(1);
});
