/**
 * Worker adapter: runs a task as a persistent Claude Code session via the
 * Claude Agent SDK (the same engine `@ai-sdk/harness-claude-code` wraps,
 * but pointed at a local cwd instead of a cloud sandbox).
 *
 * Card data flows out of here in two ways:
 *  - PROTOCOL: ask_user tool args, permission requests, and per-turn result
 *    summaries are copied onto the card verbatim.
 *  - TELEMETRY: every stream message passes through `reduce()`, a pure
 *    reducer that derives status/activity/filesTouched/toolCounts, plus a
 *    debounced `git diff --numstat` for the diffstat.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DiffStat, TaskCard, TaskQuestion } from "../types.ts";
import { asyncQueue, nextId, truncate } from "../util.ts";

export interface SpawnTaskOptions {
  brief: string;
  cwd: string;
  /** "safe" surfaces gated tool calls as needs-input cards; "full" bypasses permissions */
  autonomy: "safe" | "full";
}

export interface TaskHandle {
  /** send a follow-up message into the task thread */
  send(message: string, from: "user" | "dispatch"): void;
  /** answer the currently pending question; returns false if none/mismatched */
  answer(questionId: string, value: string): boolean;
  stop(): Promise<void>;
}

export interface TaskContext {
  card: TaskCard;
  /** mutate the card and broadcast it */
  update(mutate: (card: TaskCard) => void): void;
  /** notify the manager of a status transition (wakes the orchestrator) */
  transition(kind: "needs_input" | "done" | "failed"): void;
}

const WORKER_APPEND = `
You are running as a background task inside Dispatch, an orchestrator UI.
There is no interactive terminal. When you are blocked on a decision only a
human can make (ambiguous requirements, destructive action, a choice between
approaches), call the mcp__dispatch__ask_user tool with a concise question and
2-4 concrete options. Do not stall or guess on important decisions.
When you finish, end with a short summary of what changed and how you verified it.
`.trim();

const TRANSCRIPT_CAP = 200;
const TEXT_CAP = 600;

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

async function gitNumstat(cwd: string): Promise<DiffStat | null> {
  try {
    const proc = Bun.spawn(["git", "diff", "--numstat"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    let additions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of out.split("\n")) {
      const [a, d] = line.split("\t");
      if (a === undefined || d === undefined) continue;
      files += 1;
      additions += Number.parseInt(a, 10) || 0;
      deletions += Number.parseInt(d, 10) || 0;
    }
    return { additions, deletions, files };
  } catch {
    return null;
  }
}

function subtractBaseline(now: DiffStat, base: DiffStat | null): DiffStat {
  if (!base) return now;
  return {
    additions: Math.max(0, now.additions - base.additions),
    deletions: Math.max(0, now.deletions - base.deletions),
    files: Math.max(0, now.files - base.files),
  };
}

/** one-line description of a tool call, for the activity line + transcript */
function describeToolUse(name: string, input: Record<string, unknown>): string | null {
  const p = (key: string) => {
    const v = input[key];
    return typeof v === "string" ? v : "";
  };
  switch (name) {
    case "Bash":
      return `$ ${truncate(p("command"), 90)}`;
    case "Edit":
    case "MultiEdit":
      return `edit ${shortPath(p("file_path"))}`;
    case "Write":
      return `write ${shortPath(p("file_path"))}`;
    case "NotebookEdit":
      return `edit ${shortPath(p("notebook_path"))}`;
    case "Read":
      return `read ${shortPath(p("file_path"))}`;
    case "Glob":
      return `glob ${truncate(p("pattern"), 60)}`;
    case "Grep":
      return `grep ${truncate(p("pattern"), 60)}`;
    case "WebFetch":
      return `fetch ${truncate(p("url"), 70)}`;
    case "WebSearch":
      return `search ${truncate(p("query"), 60)}`;
    case "Task":
      return `subagent: ${truncate(p("description"), 60)}`;
    case "TodoWrite":
      return null; // noise
    default:
      return name.startsWith("mcp__") ? null : name;
  }
}

function shortPath(filePath: string): string {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length <= 3 ? filePath : parts.slice(-3).join("/");
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const DIFF_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"]);

export function spawnClaudeCodeTask(
  opts: SpawnTaskOptions,
  ctx: TaskContext,
): TaskHandle {
  const input = asyncQueue<SDKUserMessage>();
  input.push(userMessage(opts.brief));

  /** questionId -> resolver for the pending needs-input promise */
  const pendingAnswers = new Map<string, (value: string) => void>();
  /** tools the user said "always allow" for this task */
  const alwaysAllowed = new Set<string>();
  let stopped = false;
  let diffBaseline: DiffStat | null = null;
  let diffTimer: ReturnType<typeof setTimeout> | null = null;

  void gitNumstat(opts.cwd).then((stat) => {
    diffBaseline = stat;
  });

  const scheduleDiffstat = () => {
    if (diffTimer) return;
    diffTimer = setTimeout(async () => {
      diffTimer = null;
      const stat = await gitNumstat(opts.cwd);
      if (stat) {
        ctx.update((card) => {
          card.diff = subtractBaseline(stat, diffBaseline);
        });
      }
    }, 1500);
  };

  /** park the task on a question and wait for the human */
  const waitForAnswer = (question: Omit<TaskQuestion, "id">): Promise<string> =>
    new Promise<string>((resolve) => {
      const q: TaskQuestion = { ...question, id: nextId("q") };
      pendingAnswers.set(q.id, resolve);
      ctx.update((card) => {
        card.status = "needs_input";
        card.question = q;
        card.activity = "Waiting on your answer";
      });
      ctx.transition("needs_input");
    }).then((value) => {
      ctx.update((card) => {
        card.status = "running";
        card.question = null;
        card.activity = "Resumed with your answer";
        card.transcript.push({ role: "dispatch", text: `answered: ${truncate(value, 200)}`, at: Date.now() });
      });
      return value;
    });

  const askUser = tool(
    "ask_user",
    "Ask the human a blocking question. Use when you need a decision you cannot make yourself. Provide 2-4 concrete options where possible.",
    {
      question: z.string().describe("The question, one or two sentences."),
      options: z
        .array(
          z.object({
            label: z.string().describe("Short label, e.g. 'A — dedup on event.id'"),
            description: z.string().optional().describe("One-line tradeoff"),
          }),
        )
        .optional(),
    },
    async (args) => {
      const value = await waitForAnswer({
        kind: "question",
        text: args.question,
        options: args.options ?? [],
        freeform: true,
      });
      return { content: [{ type: "text", text: `The user answered: ${value}` }] };
    },
  );

  const session = query({
    prompt: input.iterable,
    options: {
      cwd: opts.cwd,
      // "full" autonomy auto-approves in canUseTool below rather than using
      // bypassPermissions, which the CLI refuses under root (containers).
      permissionMode: "acceptEdits",
      systemPrompt: { type: "preset", preset: "claude_code", append: WORKER_APPEND },
      mcpServers: {
        dispatch: createSdkMcpServer({ name: "dispatch", version: "1.0.0", tools: [askUser] }),
      },
      allowedTools: ["mcp__dispatch__ask_user"],
      disallowedTools: ["AskUserQuestion"],
      includePartialMessages: false,
      canUseTool: async (toolName, toolInput) => {
        if (opts.autonomy === "full" || alwaysAllowed.has(toolName)) {
          return { behavior: "allow", updatedInput: toolInput };
        }
        const detail = describeToolUse(toolName, toolInput) ?? toolName;
        const value = await waitForAnswer({
          kind: "permission",
          text: `Wants to run: ${detail}`,
          options: [
            { label: "Allow once" },
            { label: "Always allow " + toolName, description: "for this task" },
            { label: "Deny" },
          ],
          freeform: false,
        });
        if (value.startsWith("Always allow")) {
          alwaysAllowed.add(toolName);
          return { behavior: "allow", updatedInput: toolInput };
        }
        if (value === "Allow once") {
          return { behavior: "allow", updatedInput: toolInput };
        }
        return {
          behavior: "deny",
          message:
            "The user denied this action. Find another approach, or ask why via mcp__dispatch__ask_user.",
        };
      },
    },
  });

  const pushTranscript = (role: "agent" | "dispatch" | "tool", text: string) => {
    ctx.update((card) => {
      card.transcript.push({ role, text: truncate(text, TEXT_CAP), at: Date.now() });
      if (card.transcript.length > TRANSCRIPT_CAP) {
        card.transcript.splice(0, card.transcript.length - TRANSCRIPT_CAP);
      }
    });
  };

  /** the telemetry reducer: SDK stream message -> card mutations */
  const reduce = (message: Record<string, any>) => {
    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          ctx.update((card) => {
            card.status = "running";
            card.activity = `Session started (${message.model ?? "claude"})`;
          });
        }
        break;
      }
      case "assistant": {
        const content: any[] = message.message?.content ?? [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            pushTranscript("agent", block.text);
            ctx.update((card) => {
              card.activity = truncate(block.text.split("\n")[0] ?? "", 110);
            });
          } else if (block.type === "tool_use") {
            const name: string = block.name ?? "tool";
            const desc = describeToolUse(name, block.input ?? {});
            ctx.update((card) => {
              card.toolCounts[name] = (card.toolCounts[name] ?? 0) + 1;
              if (FILE_TOOLS.has(name)) {
                const fp = block.input?.file_path ?? block.input?.notebook_path;
                if (typeof fp === "string" && !card.filesTouched.includes(fp)) {
                  card.filesTouched.push(fp);
                }
              }
              if (desc) card.activity = desc;
            });
            if (desc) pushTranscript("tool", desc);
            if (DIFF_TOOLS.has(name)) scheduleDiffstat();
          }
        }
        break;
      }
      case "result": {
        // In streaming-input mode a `result` closes each TURN, not the session.
        // The thread stays alive for follow-ups; "done" here means "idle, turn complete".
        const isError = message.is_error === true || message.subtype !== "success";
        const resultText: string =
          typeof message.result === "string" ? message.result : "";
        ctx.update((card) => {
          card.status = stopped ? "stopped" : isError ? "failed" : "done";
          card.summary = resultText ? truncate(resultText, 1500) : card.summary;
          card.costUsd = (card.costUsd ?? 0) + (message.total_cost_usd ?? 0);
          card.turns = (card.turns ?? 0) + (message.num_turns ?? 1);
          card.endedAt = Date.now();
          card.activity = isError
            ? truncate(`Turn failed: ${message.subtype}`, 110)
            : "Turn complete";
        });
        scheduleDiffstat();
        if (!stopped) ctx.transition(isError ? "failed" : "done");
        break;
      }
      default:
        break;
    }
  };

  void (async () => {
    try {
      for await (const message of session) {
        reduce(message as Record<string, any>);
      }
    } catch (error) {
      if (!stopped) {
        ctx.update((card) => {
          card.status = "failed";
          card.activity = truncate(`Session error: ${String(error)}`, 160);
          card.endedAt = Date.now();
        });
        ctx.transition("failed");
      }
    }
  })();

  return {
    send(message, from) {
      pushTranscript("dispatch", `${from} › ${message}`);
      ctx.update((card) => {
        card.status = "running";
        card.endedAt = null;
        card.activity = "Working on follow-up";
      });
      input.push(userMessage(message));
    },
    answer(questionId, value) {
      const resolve = pendingAnswers.get(questionId);
      if (!resolve) return false;
      pendingAnswers.delete(questionId);
      resolve(value);
      return true;
    },
    async stop() {
      stopped = true;
      ctx.update((card) => {
        card.status = "stopped";
        card.activity = "Stopped by user";
        card.endedAt = Date.now();
      });
      try {
        await session.interrupt();
      } catch {
        // already gone
      }
      input.end();
    },
  };
}
