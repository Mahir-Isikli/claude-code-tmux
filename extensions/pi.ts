import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  captureSession,
  listJobs,
  listSessions,
  safeName,
  sendPrompt,
  startSession,
  steerSession,
} from "../src/core.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ccmux_start",
    label: "Start Claude Code tmux",
    description: "Start or reuse an interactive Claude Code session inside tmux.",
    promptSnippet: "Start or reuse a durable interactive Claude Code session in tmux",
    promptGuidelines: [
      "Use ccmux_start before ccmux_send when no Claude Code tmux session exists for the requested workspace.",
      "Use ccmux_send to delegate coding work to interactive Claude Code in tmux, not as a normal LLM provider.",
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
