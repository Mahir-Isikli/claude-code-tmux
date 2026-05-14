import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOME = path.join(os.homedir(), ".pi", "ccmux");
export const STATE_VERSION = 1;

export class CcmuxError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CcmuxError";
    this.details = details;
  }
}

export function expandHome(value) {
  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function safeName(value) {
  const cleaned = String(value || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || "default";
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function ensureHome(home = DEFAULT_HOME) {
  const root = expandHome(home);
  mkdirSync(root, { recursive: true });
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "jobs"), { recursive: true });
  return root;
}

function statePath(home = DEFAULT_HOME) {
  return path.join(ensureHome(home), "state.json");
}

export function loadState(home = DEFAULT_HOME) {
  const file = statePath(home);
  if (!existsSync(file)) return { version: STATE_VERSION, sessions: {}, jobs: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {
    version: parsed.version ?? STATE_VERSION,
    sessions: parsed.sessions ?? {},
    jobs: parsed.jobs ?? {},
  };
}

export function saveState(state, home = DEFAULT_HOME) {
  const file = statePath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function tmux(args, options = {}) {
  const result = spawnSync("tmux", args, {
    encoding: "utf8",
    cwd: options.cwd,
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) {
    throw new CcmuxError(`Failed to run tmux: ${result.error.message}`, { args });
  }
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new CcmuxError(`tmux ${args.join(" ")} failed: ${result.stderr || result.stdout}`.trim(), {
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return result;
}

export function assertTmuxAvailable() {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new CcmuxError("tmux is required but was not found on PATH");
  }
  return result.stdout.trim();
}

export function sessionExists(tmuxSession) {
  const result = tmux(["has-session", "-t", tmuxSession], { allowFailure: true });
  return result.status === 0;
}

export function buildClaudeCommand(options = {}) {
  const argv = [options.claudePath || "claude"];
  if (options.permissionMode) argv.push("--permission-mode", options.permissionMode);
  if (options.model) argv.push("--model", options.model);
  if (options.effort) argv.push("--effort", options.effort);
  if (options.name) argv.push("--name", options.name);
  if (options.remoteControl) {
    argv.push("--remote-control");
    if (typeof options.remoteControl === "string" && options.remoteControl.trim()) {
      argv.push(options.remoteControl.trim());
    }
  }
  if (options.dangerouslySkipPermissions) argv.push("--dangerously-skip-permissions");
  if (Array.isArray(options.extraArgs)) argv.push(...options.extraArgs);
  return argv.map(shellQuote).join(" ");
}

export function startSession(options = {}) {
  assertTmuxAvailable();
  const home = ensureHome(options.home);
  const name = safeName(options.name || path.basename(process.cwd()));
  const cwd = path.resolve(expandHome(options.cwd || process.cwd()));
  const tmuxSession = options.tmuxSession || `ccmux-${name}`;
  const logPath = path.join(home, "logs", `${name}.ansi.log`);
  const command = buildClaudeCommand({ ...options, name: options.claudeSessionName || name });
  const state = loadState(home);

  if (!sessionExists(tmuxSession)) {
    tmux(["new-session", "-d", "-s", tmuxSession, "-c", cwd, command]);
  }

  tmux(["pipe-pane", "-o", "-t", tmuxSession, `cat >> ${shellQuote(logPath)}`]);

  const now = new Date().toISOString();
  state.sessions[name] = {
    name,
    tmuxSession,
    cwd,
    command,
    logPath,
    createdAt: state.sessions[name]?.createdAt ?? now,
    updatedAt: now,
    remoteControl: Boolean(options.remoteControl),
  };
  saveState(state, home);

  return state.sessions[name];
}

export function getSession(name, home = DEFAULT_HOME) {
  const state = loadState(home);
  const safe = safeName(name || "default");
  const session = state.sessions[safe];
  if (!session) throw new CcmuxError(`No ccmux session named ${safe}`);
  return session;
}

export function listSessions(home = DEFAULT_HOME) {
  const state = loadState(home);
  return Object.values(state.sessions).map((session) => ({
    ...session,
    alive: sessionExists(session.tmuxSession),
  }));
}

export function killSession(name, home = DEFAULT_HOME) {
  const state = loadState(home);
  const safe = safeName(name || "default");
  const session = state.sessions[safe];
  if (!session) throw new CcmuxError(`No ccmux session named ${safe}`);
  const result = tmux(["kill-session", "-t", session.tmuxSession], { allowFailure: true });
  delete state.sessions[safe];
  saveState(state, home);
  return { killed: result.status === 0, session };
}

export function captureSession(name, options = {}) {
  const session = getSession(name, options.home);
  const lines = Number(options.lines ?? 120);
  const result = tmux(["capture-pane", "-p", "-J", "-S", String(-Math.abs(lines)), "-t", session.tmuxSession], {
    allowFailure: true,
  });
  return {
    session,
    ok: result.status === 0,
    text: result.stdout ?? "",
    error: result.stderr ?? "",
  };
}

export function makeJob(options = {}) {
  const home = ensureHome(options.home);
  const session = getSession(options.session || "default", home);
  if (!sessionExists(session.tmuxSession)) {
    throw new CcmuxError(`tmux session ${session.tmuxSession} is not running`);
  }

  const id = options.jobId || randomUUID();
  const marker = `CCMUX_DONE:${id}`;
  const promptPath = path.join(home, "jobs", `${id}.prompt.txt`);
  const doneRoot = path.resolve(expandHome(options.doneRoot || path.join(session.cwd, ".ccmux", "jobs")));
  mkdirSync(doneRoot, { recursive: true });
  const donePath = path.join(doneRoot, `${id}.done.json`);
  const prompt = buildPrompt({
    task: options.prompt,
    id,
    marker,
    donePath,
    protocol: options.protocol !== false,
  });
  writeFileSync(promptPath, prompt);

  const now = new Date().toISOString();
  const state = loadState(home);
  const job = {
    id,
    marker,
    session: session.name,
    tmuxSession: session.tmuxSession,
    cwd: session.cwd,
    promptPath,
    donePath,
    logPath: session.logPath,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  };
  state.jobs[id] = job;
  state.sessions[session.name] = { ...session, lastJobId: id, updatedAt: now };
  saveState(state, home);
  return job;
}

export function buildPrompt({ task, id, marker, donePath, protocol = true }) {
  const body = String(task || "").trim();
  if (!protocol) return body;
  const markerPrefix = "CCMUX_DONE:";
  return `${body}\n\n` +
    `<ccmux_completion_protocol>\n` +
    `This request is controlled by ccmux job ${id}.\n` +
    `When you are fully done, include one completion marker line in your final response.\n` +
    `The marker line is the literal prefix ${markerPrefix} followed immediately by this job id: ${id}\n` +
    `Do not add spaces, quotes, or punctuation to the marker line.\n` +
    `If you used tools or changed files, also create this JSON file before the final response:\n` +
    `${donePath}\n` +
    `The JSON may contain status, summary, files_changed, and notes.\n` +
    `</ccmux_completion_protocol>`;
}

export function sendJob(job, options = {}) {
  const home = ensureHome(options.home);
  const state = loadState(home);
  const current = state.jobs[job.id] ?? job;
  tmux(["load-buffer", "-b", `ccmux-${job.id}`, job.promptPath]);
  tmux(["paste-buffer", "-dpr", "-b", `ccmux-${job.id}`, "-t", job.tmuxSession]);
  tmux(["send-keys", "-t", job.tmuxSession, "Enter"]);
  const now = new Date().toISOString();
  state.jobs[job.id] = { ...current, status: "sent", sentAt: now, updatedAt: now };
  saveState(state, home);
  return state.jobs[job.id];
}

export async function sendPrompt(options = {}) {
  const job = makeJob(options);
  const sent = sendJob(job, options);
  if (!options.wait) return sent;
  return await waitForJob(sent.id, options);
}

export function steerSession(options = {}) {
  const home = ensureHome(options.home);
  const session = getSession(options.session || "default", home);
  const id = `steer-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const promptPath = path.join(home, "jobs", `${id}.prompt.txt`);
  const message = `Steering update from ccmux:\n${String(options.message || "").trim()}`;
  writeFileSync(promptPath, message);
  tmux(["load-buffer", "-b", id, promptPath]);
  tmux(["paste-buffer", "-dpr", "-b", id, "-t", session.tmuxSession]);
  tmux(["send-keys", "-t", session.tmuxSession, "Enter"]);
  return { session: session.name, tmuxSession: session.tmuxSession, message };
}

export function getJob(id, home = DEFAULT_HOME) {
  const state = loadState(home);
  const job = state.jobs[id];
  if (!job) throw new CcmuxError(`No ccmux job ${id}`);
  return refreshJob(job, home);
}

export function listJobs(home = DEFAULT_HOME) {
  const state = loadState(home);
  return Object.values(state.jobs).map((job) => refreshJob(job, home));
}

export function refreshJob(job, home = DEFAULT_HOME) {
  const doneFile = readDoneFile(job.donePath);
  const tail = readTail(job.logPath, 256 * 1024);
  const cleanTail = stripAnsi(tail);
  const markerPattern = new RegExp(`CCMUX_DONE:\\s*${escapeRegExp(job.id)}`);
  const markerSeen = cleanTail.includes(job.marker) || tail.includes(job.marker) || markerPattern.test(cleanTail);
  const status = doneFile || markerSeen ? "done" : job.status;
  return {
    ...job,
    status,
    doneFile,
    markerSeen,
    logTail: cleanTail.slice(-8000),
  };
}

export async function waitForJob(id, options = {}) {
  const home = ensureHome(options.home);
  const timeoutMs = Number(options.timeoutMs ?? options.timeout ?? 10 * 60 * 1000);
  const pollMs = Number(options.pollMs ?? 1000);
  const settleMs = Number(options.settleMs ?? 3000);
  const started = Date.now();
  let doneFileFirstSeenAt = null;
  while (Date.now() - started < timeoutMs) {
    const job = getJob(id, home);
    if (job.markerSeen) {
      updateJobStatus(id, "done", home);
      return job;
    }
    if (job.doneFile) {
      doneFileFirstSeenAt ??= Date.now();
      if (Date.now() - doneFileFirstSeenAt >= settleMs) {
        updateJobStatus(id, "done", home);
        return getJob(id, home);
      }
    }
    await sleep(pollMs);
  }
  const job = getJob(id, home);
  updateJobStatus(id, "timeout", home);
  return { ...job, status: "timeout" };
}

export function updateJobStatus(id, status, home = DEFAULT_HOME) {
  const state = loadState(home);
  if (state.jobs[id]) {
    state.jobs[id].status = status;
    state.jobs[id].updatedAt = new Date().toISOString();
    saveState(state, home);
  }
}

export function readDoneFile(file) {
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { raw: readFileSync(file, "utf8") };
  }
}

export function readTail(file, maxBytes = 64 * 1024) {
  if (!file || !existsSync(file)) return "";
  const stats = statSync(file);
  const start = Math.max(0, stats.size - maxBytes);
  const length = stats.size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

export function stripAnsi(value) {
  return String(value || "")
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()#][0-9A-Za-z]/g, "")
    .replace(/\r/g, "\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
