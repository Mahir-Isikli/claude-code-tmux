import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_HOME = process.env.CCMUX_HOME || path.join(os.homedir(), ".pi", "ccmux");
export const DEFAULT_MODEL = process.env.CCMUX_MODEL || "opus";
export const DEFAULT_EFFORT = process.env.CCMUX_EFFORT || "high";
export const STATE_VERSION = 1;
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  mkdirSync(path.join(root, "events"), { recursive: true });
  mkdirSync(path.join(root, "hooks"), { recursive: true });
  mkdirSync(path.join(root, "pi-tool-requests"), { recursive: true });
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

export function discoverAgentsMd(cwd = process.cwd(), options = {}) {
  const start = path.resolve(expandHome(cwd || process.cwd()));
  const requested = options.agentsMd;
  if (requested === false || requested === "false" || requested === "0" || requested === "none") return [];

  const explicit = normalizeAgentsMdInput(requested);
  if (explicit.length > 0) {
    return uniquePaths(
      explicit.map((file) => resolveFromCwd(file, start)).filter((file) => existsSync(file)),
    );
  }

  const home = os.homedir();
  const files = [];
  let current = start;
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (existsSync(candidate)) files.push(candidate);
    const parent = path.dirname(current);
    if (current === parent || current === home) break;
    current = parent;
  }
  return uniquePaths(files.reverse());
}

export function prepareAgentsContext(options = {}) {
  const cwd = path.resolve(expandHome(options.cwd || process.cwd()));
  const files = discoverAgentsMd(cwd, { agentsMd: options.agentsMd });
  if (files.length === 0) return { files: [], promptPath: undefined };

  const home = ensureHome(options.home);
  const dir = path.join(home, "instructions");
  mkdirSync(dir, { recursive: true });
  const promptPath = path.join(dir, `${safeName(options.name || path.basename(cwd))}.agents.md`);
  const content = [
    "# AGENTS.md instructions imported by ccmux",
    "",
    "Claude Code normally discovers CLAUDE.md. ccmux found these AGENTS.md files and is providing them as additional project instructions. Follow the more specific file when instructions conflict.",
    "",
    ...files.flatMap((file) => [
      `## ${file}`,
      "",
      readFileSync(file, "utf8"),
      "",
    ]),
  ].join("\n");
  writeFileSync(promptPath, content);
  return { files, promptPath };
}

function normalizeAgentsMdInput(value) {
  if (!value || value === true || value === "true" || value === "auto") return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  return values.map((item) => item.trim()).filter(Boolean);
}

function resolveFromCwd(file, cwd) {
  const expanded = expandHome(file);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

function uniquePaths(files) {
  return [...new Set(files)];
}

export function hookCommandPath() {
  return path.join(PACKAGE_ROOT, "bin", "ccmux-hook.mjs");
}

export function piToolCommandPath() {
  return path.join(PACKAGE_ROOT, "bin", "ccmux-pi-tool.mjs");
}

export function buildHookCommand(options = {}) {
  const argv = [process.execPath, options.hookCommand || hookCommandPath(), "--home", ensureHome(options.home)];
  return argv.map(shellQuote).join(" ");
}

export function prepareHookSettings(options = {}) {
  const home = ensureHome(options.home);
  const dir = path.join(home, "hooks");
  mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, `${safeName(options.name || "default")}.settings.json`);
  const command = buildHookCommand({ home, hookCommand: options.hookCommand });
  const hook = { type: "command", command, timeout: Number(process.env.CCMUX_HOOK_TIMEOUT_SECONDS ?? 5) };
  const toolHook = { matcher: "", hooks: [hook] };
  const turnHook = { hooks: [hook] };
  const settings = {
    hooks: {
      SessionStart: [turnHook],
      UserPromptSubmit: [turnHook],
      PreToolUse: [toolHook],
      PostToolUse: [toolHook],
      PostToolUseFailure: [toolHook],
      PostToolBatch: [turnHook],
      PermissionRequest: [toolHook],
      PermissionDenied: [toolHook],
      Notification: [turnHook],
      SubagentStart: [turnHook],
      SubagentStop: [turnHook],
      Stop: [turnHook],
      StopFailure: [turnHook],
      SessionEnd: [turnHook],
    },
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, command, settings };
}

export function buildClaudeCommand(options = {}) {
  const argv = [options.claudePath || "claude"];
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  if (options.permissionMode) argv.push("--permission-mode", options.permissionMode);
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (options.name) argv.push("--name", options.name);
  if (options.remoteControl) {
    argv.push("--remote-control");
    if (typeof options.remoteControl === "string" && options.remoteControl.trim()) {
      argv.push(options.remoteControl.trim());
    }
  }
  if (options.settingsPath) argv.push("--settings", options.settingsPath);
  if (options.agentsPromptPath) argv.push("--append-system-prompt-file", options.agentsPromptPath);
  if (options.dangerouslySkipPermissions !== false) argv.push("--dangerously-skip-permissions");
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
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const dangerouslySkipPermissions = options.dangerouslySkipPermissions !== false;
  const agentsContext = prepareAgentsContext({ cwd, name, home, agentsMd: options.agentsMd });
  const hooksContext = options.hooks ? prepareHookSettings({ home, name, cwd, hookCommand: options.hookCommand }) : { settingsPath: undefined };
  const command = buildClaudeCommand({
    ...options,
    name: options.claudeSessionName || name,
    model,
    effort,
    dangerouslySkipPermissions,
    agentsPromptPath: agentsContext.promptPath,
    settingsPath: hooksContext.settingsPath,
  });
  const state = loadState(home);
  const alreadyRunning = sessionExists(tmuxSession);

  if (!alreadyRunning) {
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
    model,
    effort,
    dangerouslySkipPermissions,
    agentsFiles: agentsContext.files,
    agentsPromptPath: agentsContext.promptPath,
    hooksSettingsPath: hooksContext.settingsPath,
    reused: alreadyRunning,
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

export function prepareSessionForInput(name, options = {}) {
  const session = typeof name === "string" ? getSession(name, options.home) : name;
  const timeoutMs = Number(options.timeoutMs ?? 30_000);
  const pollMs = Number(options.pollMs ?? 1000);
  const started = Date.now();
  let acceptedTrust = false;

  while (Date.now() - started < timeoutMs) {
    const result = tmux(["capture-pane", "-p", "-J", "-S", "-120", "-t", session.tmuxSession], { allowFailure: true });
    const text = stripAnsi(result.stdout ?? "");
    if (/Quick safety check|Yes, I trust this folder|Enter to confirm/.test(text)) {
      tmux(["send-keys", "-t", session.tmuxSession, "C-m"]);
      acceptedTrust = true;
      sleepSync(2500);
      continue;
    }
    if (/❯\s*$|bypass permissions on|accept edits on|plan mode on/.test(text)) {
      return { ready: true, acceptedTrust, session };
    }
    sleepSync(pollMs);
  }

  return { ready: false, acceptedTrust, session };
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
    requireDoneFile: options.requireDoneFile === true,
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

export function buildPrompt({ task, id, marker, donePath, protocol = true, requireDoneFile = false }) {
  const body = String(task || "").trim();
  if (!protocol) return body;
  const markerPrefix = "CCMUX_DONE:";
  const doneFileInstruction = requireDoneFile
    ? `Before the final response, create this JSON file:\n${donePath}\n`
    : `If you used tools or changed files, also create this JSON file before the final response:\n${donePath}\n`;
  return `${body}\n\n` +
    `<ccmux_completion_protocol>\n` +
    `This request is controlled by ccmux job ${id}.\n` +
    `When you are fully done, include one completion marker line in your final response.\n` +
    `The marker line is the literal prefix ${markerPrefix} followed immediately by this job id: ${id}\n` +
    `Do not add spaces, quotes, or punctuation to the marker line.\n` +
    doneFileInstruction +
    `The JSON may contain status, summary, final_response, files_changed, and notes.\n` +
    `</ccmux_completion_protocol>`;
}

export function sendJob(job, options = {}) {
  const home = ensureHome(options.home);
  const state = loadState(home);
  const current = state.jobs[job.id] ?? job;
  const bufferName = `ccmux-${job.id}`;
  tmux(["load-buffer", "-b", bufferName, job.promptPath]);
  const promptBytes = statSync(job.promptPath).size;
  const defaultPasteDelayMs = Math.min(5000, Math.max(500, Math.ceil(promptBytes / 4)));
  const pasteDelayMs = Number(options.pasteDelayMs ?? process.env.CCMUX_PASTE_DELAY_MS ?? defaultPasteDelayMs);
  const maxPasteAttempts = Number(options.maxPasteAttempts ?? process.env.CCMUX_MAX_PASTE_ATTEMPTS ?? 3);
  for (let attempt = 1; attempt <= maxPasteAttempts; attempt++) {
    tmux(["paste-buffer", "-p", "-r", "-b", bufferName, "-t", job.tmuxSession]);
    sleepSync(pasteDelayMs);
    const visible = stripAnsi(tmux(["capture-pane", "-p", "-J", "-S", "-120", "-t", job.tmuxSession]).stdout ?? "");
    if (visible.includes(job.id)) break;
    if (attempt === maxPasteAttempts) {
      throw new CcmuxError(`Pasted prompt for job ${job.id}, but it was not visible in tmux pane`, { job });
    }
    tmux(["send-keys", "-t", job.tmuxSession, "C-u"]);
    sleepSync(500);
  }
  tmux(["delete-buffer", "-b", bufferName], { allowFailure: true });
  tmux(["send-keys", "-t", job.tmuxSession, "C-m"]);
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
  tmux(["send-keys", "-t", session.tmuxSession, "C-m"]);
  return { session: session.name, tmuxSession: session.tmuxSession, message };
}

export function getJob(id, home = DEFAULT_HOME) {
  const state = loadState(home);
  const job = state.jobs[id];
  if (!job) throw new CcmuxError(`No ccmux job ${id}`);
  return refreshJob(job, home);
}

export function findActiveJobForSession(sessionName, home = DEFAULT_HOME) {
  const state = loadState(home);
  const jobs = Object.values(state.jobs)
    .filter((job) => job.session === sessionName)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jobs.find((job) => job.status !== "done" && job.status !== "timeout") ?? jobs[0];
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

export function extractJobIdFromText(text) {
  const match = String(text || "").match(/ccmux job ([0-9a-fA-F-]{36})|CCMUX_DONE:\s*([0-9a-fA-F-]{36})/);
  return match?.[1] || match?.[2] || undefined;
}

function hookSessionMapPath(home = DEFAULT_HOME) {
  return path.join(ensureHome(home), "hooks", "session-map.json");
}

function piToolRequestDir(jobId, home = DEFAULT_HOME) {
  const dir = path.join(ensureHome(home), "pi-tool-requests", jobId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writePiToolRequest({ jobId, id = randomUUID(), toolName, arguments: args = {}, timeoutMs }, home = DEFAULT_HOME) {
  if (!jobId) throw new CcmuxError("writePiToolRequest requires jobId");
  if (!toolName) throw new CcmuxError("writePiToolRequest requires toolName");
  const dir = piToolRequestDir(jobId, home);
  const request = {
    id,
    jobId,
    toolName,
    arguments: args,
    timeoutMs,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, `${id}.request.json`), JSON.stringify(request, null, 2));
  return request;
}

export function listPendingPiToolRequests(jobId, options = {}) {
  const dir = piToolRequestDir(jobId, options.home);
  const dispatched = new Set(options.dispatchedIds || []);
  let entries = [];
  try {
    entries = readdirSync(dir)
      .filter((name) => name.endsWith(".request.json"))
      .map((name) => {
        try {
          return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
        } catch {
          return undefined;
        }
      })
      .filter(Boolean)
      .filter((request) => !dispatched.has(request.id) && !existsSync(path.join(dir, `${request.id}.response.json`)));
  } catch {
    return [];
  }
  return entries.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function writePiToolResponse(jobId, requestId, response, home = DEFAULT_HOME) {
  const dir = piToolRequestDir(jobId, home);
  const payload = {
    requestId,
    jobId,
    createdAt: new Date().toISOString(),
    ...response,
  };
  writeFileSync(path.join(dir, `${requestId}.response.json`), JSON.stringify(payload, null, 2));
  return payload;
}

export function readPiToolResponse(jobId, requestId, home = DEFAULT_HOME) {
  const file = path.join(piToolRequestDir(jobId, home), `${requestId}.response.json`);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function loadHookSessionMap(home = DEFAULT_HOME) {
  const file = hookSessionMapPath(home);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveHookSessionMap(map, home = DEFAULT_HOME) {
  const file = hookSessionMapPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(map, null, 2));
  renameSync(tmp, file);
}

export function normalizeHookEvent(input = {}, options = {}) {
  const event = {
    id: options.id || randomUUID(),
    timestamp: options.timestamp || new Date().toISOString(),
    jobId: options.jobId,
    hookEventName: input.hook_event_name || input.hookEventName || "unknown",
    sessionId: input.session_id || input.sessionId,
    transcriptPath: input.transcript_path || input.transcriptPath,
    cwd: input.cwd,
    permissionMode: input.permission_mode || input.permissionMode,
    toolName: input.tool_name || input.toolName,
    toolInput: input.tool_input || input.toolInput,
    toolResponse: input.tool_response || input.toolResponse,
    toolUseId: input.tool_use_id || input.toolUseId,
    prompt: input.prompt,
    source: input.source,
    notificationType: input.notification_type || input.notificationType,
    message: input.message,
    error: input.error,
    raw: input,
  };
  if (!event.jobId) event.jobId = extractJobIdFromText(event.prompt) || extractJobIdFromText(JSON.stringify(input));
  return event;
}

export function recordHookEvent(input = {}, options = {}) {
  const home = ensureHome(options.home);
  const map = loadHookSessionMap(home);
  let jobId = extractJobIdFromText(input.prompt) || extractJobIdFromText(JSON.stringify(input));
  const sessionId = input.session_id || input.sessionId;
  if (sessionId && !jobId) jobId = map[sessionId];
  const event = normalizeHookEvent(input, { jobId });
  if (sessionId && event.jobId) {
    map[sessionId] = event.jobId;
    saveHookSessionMap(map, home);
  }

  const allPath = path.join(home, "events", "all.jsonl");
  appendFileSync(allPath, JSON.stringify(event) + "\n");
  if (event.jobId) {
    const jobPath = path.join(home, "events", `${event.jobId}.jsonl`);
    appendFileSync(jobPath, JSON.stringify(event) + "\n");
  }
  return event;
}

export function readHookEvents(jobId, options = {}) {
  const home = ensureHome(options.home);
  const file = path.join(home, "events", `${jobId}.jsonl`);
  const offset = Number(options.offset ?? 0);
  if (!existsSync(file)) return { events: [], nextOffset: offset, file };
  const content = readFileSync(file, "utf8");
  const slice = content.slice(offset);
  const events = slice
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  return { events, nextOffset: content.length, file };
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

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
