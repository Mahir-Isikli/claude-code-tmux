import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import path from "node:path";
import { Type } from "typebox";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  captureSession,
  listJobs,
  listSessions,
  prepareSessionForInput,
  safeName,
  sendPrompt,
  startSession,
  steerSession,
} from "../src/core.mjs";

const PROVIDER_ID = "claude-code-tmux";
const PROVIDER_API = "claude-code-tmux-api";
const PROVIDER_BASE_URL = "tmux://claude-code";
const PROVIDER_API_KEY = "ccmux-local";

interface CcmuxProviderState {
  cwd: string;
  activeProviderSession?: string;
}

export default function (pi: ExtensionAPI) {
  const providerState: CcmuxProviderState = { cwd: process.cwd() };

  pi.on("session_start", async (_event, ctx) => {
    providerState.cwd = ctx.cwd;
  });

  pi.on("session_shutdown", async () => {
    providerState.activeProviderSession = undefined;
  });

  pi.registerProvider(PROVIDER_ID, {
    name: "Claude Code tmux",
    baseUrl: PROVIDER_BASE_URL,
    apiKey: PROVIDER_API_KEY,
    api: PROVIDER_API,
    models: [
      providerModel("opus", "Claude Code tmux Opus"),
      providerModel("sonnet", "Claude Code tmux Sonnet"),
    ],
    streamSimple: (model, context, options) => streamCcmuxProvider(model, context, options, providerState),
  });

  pi.registerTool({
    name: "ccmux_start",
    label: "Start Claude Code tmux",
    description: "Start or reuse an interactive Claude Code session inside tmux.",
    promptSnippet: "Start or reuse a durable interactive Claude Code session in tmux",
    promptGuidelines: [
      "Use ccmux_start before ccmux_send when no Claude Code tmux session exists for the requested workspace.",
      "Use ccmux_send to delegate coding work to interactive Claude Code in tmux, not as a normal LLM provider.",
      "Use the claude-code-tmux provider when the user explicitly asks to run Pi itself on the tmux-backed Claude Code provider.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Short session name. Defaults to cwd basename." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for Claude Code." })),
      permissionMode: Type.Optional(Type.String({ description: "Optional Claude Code permission mode. ccmux uses dangerously skip permissions by default." })),
      model: Type.Optional(Type.String({ description: `Claude Code model alias or full id. Defaults to ${DEFAULT_MODEL}, currently latest Opus.` })),
      effort: Type.Optional(Type.String({ description: `Effort level, for example high, xhigh, max. Defaults to ${DEFAULT_EFFORT}.` })),
      dangerouslySkipPermissions: Type.Optional(Type.Boolean({ description: "Pass --dangerously-skip-permissions. Defaults to true." })),
      agentsMd: Type.Optional(Type.Boolean({ description: "Auto-import AGENTS.md files from parent directories. Defaults to true." })),
      remoteControl: Type.Optional(Type.Boolean({ description: "Also enable Claude Code Remote Control." })),
    }),
    async execute(_toolCallId, params) {
      const session = startSession({
        name: params.name,
        cwd: params.cwd,
        permissionMode: params.permissionMode,
        model: params.model,
        effort: params.effort,
        dangerouslySkipPermissions: params.dangerouslySkipPermissions !== false,
        agentsMd: params.agentsMd !== false,
        remoteControl: params.remoteControl ? params.name || true : false,
      });
      return {
        content: [
          {
            type: "text",
            text: `Started Claude Code tmux session ${session.name} (${session.tmuxSession}) in ${session.cwd}. Log: ${session.logPath}`,
          },
        ],
        details: { session },
      };
    },
  });

  pi.registerTool({
    name: "ccmux_send",
    label: "Send to Claude Code tmux",
    description: "Send a task to a durable interactive Claude Code tmux session and optionally wait for the completion marker.",
    promptSnippet: "Delegate a task to interactive Claude Code in tmux and optionally wait for completion",
    promptGuidelines: [
      "Use ccmux_send when the user asks to try Claude Code through the tmux bridge or delegate implementation work to it.",
      "When ccmux_send returns a timeout, inspect ccmux_capture or ask the user before assuming the task failed.",
    ],
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "ccmux session name. Defaults to default." })),
      prompt: Type.String({ description: "Task to send to Claude Code." }),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the completion protocol marker or done file." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds." })),
      settleMs: Type.Optional(Type.Number({ description: "Extra milliseconds to wait after done file appears, unless marker appears first." })),
      protocol: Type.Optional(Type.Boolean({ description: "Append ccmux completion protocol. Defaults to true." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "Sending task to Claude Code tmux..." }] });
      const result = await sendPrompt({
        session: params.session || "default",
        prompt: params.prompt,
        wait: params.wait ?? true,
        timeoutMs: params.timeoutMs ?? 10 * 60 * 1000,
        settleMs: params.settleMs ?? 3000,
        protocol: params.protocol !== false,
      });
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Aborted while waiting for ccmux." }], isError: true };
      }
      const summary = result.doneFile?.summary ? `\nSummary: ${result.doneFile.summary}` : "";
      return {
        content: [
          {
            type: "text",
            text: `ccmux job ${result.id} is ${result.status}. Marker seen: ${Boolean(result.markerSeen)}.${summary}\nLog: ${result.logPath}\nDone file: ${result.donePath}`,
          },
        ],
        details: { job: result },
      };
    },
  });

  pi.registerTool({
    name: "ccmux_steer",
    label: "Steer Claude Code tmux",
    description: "Send a live steering update to an interactive Claude Code tmux session.",
    promptSnippet: "Send a live steering update to a running Claude Code tmux session",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "ccmux session name. Defaults to default." })),
      message: Type.String({ description: "Steering message to paste into Claude Code." }),
    }),
    async execute(_toolCallId, params) {
      const result = steerSession({ session: params.session || "default", message: params.message });
      return {
        content: [{ type: "text", text: `Sent steering update to ${result.session} (${result.tmuxSession}).` }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "ccmux_status",
    label: "Claude Code tmux status",
    description: "List ccmux sessions and jobs.",
    promptSnippet: "List Claude Code tmux sessions and jobs",
    parameters: Type.Object({}),
    async execute() {
      const sessions = listSessions();
      const jobs = listJobs().map(({ logTail, ...job }) => job);
      return {
        content: [
          {
            type: "text",
            text: `Sessions: ${sessions.length}\nJobs: ${jobs.length}\n` + JSON.stringify({ sessions, jobs }, null, 2),
          },
        ],
        details: { sessions, jobs },
      };
    },
  });

  pi.registerTool({
    name: "ccmux_capture",
    label: "Capture Claude Code tmux",
    description: "Capture recent terminal text from a ccmux tmux session.",
    promptSnippet: "Capture recent terminal text from Claude Code tmux",
    parameters: Type.Object({
      session: Type.Optional(Type.String({ description: "ccmux session name. Defaults to default." })),
      lines: Type.Optional(Type.Number({ description: "Number of lines to capture." })),
    }),
    async execute(_toolCallId, params) {
      const result = captureSession(safeName(params.session || "default"), { lines: params.lines || 120 });
      return {
        content: [{ type: "text", text: result.text || result.error || "No captured output." }],
        details: result,
        isError: !result.ok,
      };
    },
  });
}

function providerModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: true,
    thinkingLevelMap: {
      off: "high",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  };
}

function streamCcmuxProvider(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  state: CcmuxProviderState,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    stream.push({ type: "start", partial: output });
    output.content.push({ type: "text", text: "" });
    stream.push({ type: "text_start", contentIndex: 0, partial: output });

    try {
      const cwd = state.cwd || process.cwd();
      const sessionName = providerSessionName(cwd, model.id);
      const effort = effortFromReasoning(options?.reasoning);
      const session = startSession({
        name: sessionName,
        cwd,
        model: model.id,
        effort,
        dangerouslySkipPermissions: true,
        agentsMd: true,
      });
      state.activeProviderSession = session.name;
      if (!session.reused) {
        sleepSync(Number(process.env.CCMUX_PROVIDER_STARTUP_DELAY_MS ?? 8000));
      }
      const readiness = prepareSessionForInput(session, {
        timeoutMs: Number(process.env.CCMUX_PROVIDER_READY_TIMEOUT_MS ?? 45_000),
      });
      if (!readiness.ready) {
        throw new Error(`Claude Code tmux session ${session.name} was not ready for input`);
      }

      const job = await sendPrompt({
        session: session.name,
        prompt: buildProviderPrompt(context, model),
        wait: true,
        timeoutMs: Number(process.env.CCMUX_PROVIDER_TIMEOUT_MS ?? 20 * 60 * 1000),
        settleMs: Number(process.env.CCMUX_PROVIDER_SETTLE_MS ?? 2000),
        protocol: true,
        requireDoneFile: true,
        pasteDelayMs: Number(process.env.CCMUX_PROVIDER_PASTE_DELAY_MS ?? 15000),
      });

      if (options?.signal?.aborted) throw new Error("Request was aborted");

      const text = providerResponseFromJob(job);
      appendText(output, stream, text);
      stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
      stream.push({ type: "done", reason: "stop", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function appendText(output: AssistantMessage, stream: AssistantMessageEventStream, text: string) {
  const block = output.content[0];
  if (block?.type === "text") {
    block.text += text;
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
  }
}

function providerSessionName(cwd: string, modelId: string) {
  return safeName(`pi-provider-${path.basename(cwd)}-${modelId}`);
}

function effortFromReasoning(reasoning?: string) {
  if (reasoning === "minimal" || reasoning === "low") return "low";
  if (reasoning === "medium") return "medium";
  if (reasoning === "xhigh") return "xhigh";
  return "high";
}

function buildProviderPrompt(context: Context, model: Model<Api>) {
  const systemPrompt = truncateText(context.systemPrompt || "", 8_000);
  const messages = context.messages.slice(-14).map((message) => formatMessageForPrompt(message)).join("\n\n");
  const toolsNote = context.tools?.length
    ? `Pi exposed ${context.tools.length} tool definitions to its model provider. You are running inside Claude Code instead, so use Claude Code's own tools when useful and return normal text to Pi. Do not emit raw JSON tool calls.`
    : "Pi did not expose tool definitions for this request.";

  return [
    "You are serving as Pi's native claude-code-tmux provider.",
    "Behind the scenes, this request is being relayed into an interactive Claude Code session running in tmux.",
    "Answer the latest user request as a normal assistant. If useful, use Claude Code's local tools in this tmux session to inspect or edit files.",
    "Before finishing, write the ccmux done JSON with a `final_response` string containing exactly what Pi should display to the user.",
    `Selected Claude Code model alias: ${model.id}.`,
    "",
    `<pi_system_prompt>\n${systemPrompt}\n</pi_system_prompt>`,
    "",
    `<pi_tools_note>\n${toolsNote}\n</pi_tools_note>`,
    "",
    `<pi_recent_messages>\n${messages}\n</pi_recent_messages>`,
  ].join("\n");
}

function formatMessageForPrompt(message: any) {
  if (message.role === "assistant") {
    return `Assistant: ${formatAssistantContent(message.content)}`;
  }
  if (message.role === "toolResult") {
    return `Tool result (${message.toolName || message.toolCallId || "tool"}): ${truncateText(formatContent(message.content), 6000)}`;
  }
  return `${capitalize(message.role || "message")}: ${truncateText(formatContent(message.content), 8000)}`;
}

function formatAssistantContent(content: any) {
  if (!Array.isArray(content)) return truncateText(String(content ?? ""), 8000);
  return truncateText(content.map((block) => {
    if (block.type === "text") return block.text;
    if (block.type === "thinking") return `[thinking omitted]`;
    if (block.type === "toolCall") return `[tool call ${block.name} ${JSON.stringify(block.arguments ?? {})}]`;
    return `[${block.type || "content"}]`;
  }).join("\n"), 8000);
}

function formatContent(content: any) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((item) => {
    if (item.type === "text") return item.text;
    if (item.type === "image") return "[image]";
    return `[${item.type || "content"}]`;
  }).join("\n");
}

function providerResponseFromJob(job: any) {
  if (job.status === "timeout") {
    return `ccmux provider job ${job.id} timed out. Inspect it with: ccmux capture --session ${job.session} --lines 160`;
  }
  const done = job.doneFile;
  if (typeof done?.final_response === "string" && done.final_response.trim()) return done.final_response.trim();
  if (typeof done?.summary === "string" && done.summary.trim()) return done.summary.trim();
  const tail = String(job.logTail || "").trim();
  if (tail) return truncateText(tail, 4000);
  return `ccmux provider job ${job.id} completed.`;
}

function truncateText(text: string, max: number) {
  if (text.length <= max) return text;
  const half = Math.floor((max - 32) / 2);
  return `${text.slice(0, half)}\n[...truncated...]\n${text.slice(-half)}`;
}

function sleepSync(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
