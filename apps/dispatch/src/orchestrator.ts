/**
 * The orchestrator: one persistent Claude Code session you talk to.
 * It never edits code itself — its only tools are the dispatch tools below.
 *
 * It gets a turn from two sources:
 *  - the human sends a message (POST /api/message)
 *  - a task transition wakes it (done / failed / needs_input)
 * Wake turns are explicitly conservative: reply "[silent]" unless something
 * genuinely needs the human, and the server suppresses those entries.
 */
import {
  createSdkMcpServer,
  query,
  tool,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import { z } from "zod";
import { store } from "./store.ts";
import { taskManager } from "./tasks.ts";
import type { ConvEntry, TaskCard } from "./types.ts";
import { asyncQueue, nextId, truncate } from "./util.ts";

export const WORKSPACE_ROOT = path.resolve(
  process.env.DISPATCH_WORKSPACE ?? path.join(import.meta.dir, "..", "..", ".."),
);

const ORCHESTRATOR_PROMPT = `
You are Dispatch, the single orchestrator the user talks to. You manage a fleet
of coding-agent tasks (each task is a live Claude Code session working in the
user's repositories). The user sees one conversation with you; each task appears
as a live card inline in that conversation.

Core behavior:
- DELEGATE all coding work by spawning tasks. You cannot edit files or run
  commands yourself, and you must not try.
- When the user asks for work, spawn one task per independent unit of work.
  Write a thorough brief: context, constraints, how to verify, when to ask.
- The card title MUST be conventional-commit style: type(scope): summary.
  Types: feat|fix|chore|refactor|test|docs|perf|build|ci|style. Scope is the
  area of the codebase (e.g. "aws", "r2", "website"). Keep the summary under
  ~60 chars, imperative mood. Examples: "fix(r2): bound retry schedule in
  bucket tests", "feat(billing): migrate webhooks to stripe v2".
- Use read_task to check on a thread before answering questions about it.
  Quote what the worker actually said; never invent status.
- Use message_task to steer a worker or pass along the user's instructions.

Communication rules (important):
- Be brief. One or two sentences unless the user asks for detail.
- Never narrate task internals unprompted — the cards already show status.
- Messages that start with [task-event] are automated wake-ups, not the user.
  For those: if nothing needs the user's attention, reply with exactly [silent]
  Speak only when a deliverable landed, something failed in a way that needs a
  decision, or a blocked task has a question you can add a recommendation to
  (one sentence, e.g. "I'd pick A — matches the invoice worker.").
- Never reply with "[silent]" to a real user message.

The workspace root is: ${WORKSPACE_ROOT}
Spawn tasks with cwd = workspace root unless the user names another directory.
`.trim();

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    session_id: "",
  } as SDKUserMessage;
}

function cardBrief(card: TaskCard) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    activity: card.activity,
    question: card.question?.text ?? null,
    summary: card.summary,
    files: card.filesTouched.length,
    diff: card.diff,
    minutes: Math.round((Date.now() - card.startedAt) / 60000),
  };
}

class Orchestrator {
  private input = asyncQueue<SDKUserMessage>();
  private currentEntry: ConvEntry | null = null;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;

    taskManager.onTransition((card, kind) => {
      const payload = JSON.stringify(cardBrief(card));
      this.input.push(
        userMessage(
          `[task-event] ${kind} — ${payload}\n` +
            "Automated wake-up (not the user). Follow the [task-event] rules: reply [silent] unless something needs the user.",
        ),
      );
    });

    void this.run();
  }

  sendUserMessage(text: string) {
    const entry: ConvEntry = {
      id: nextId("msg"),
      role: "user",
      parts: [{ t: "text", text }],
      at: Date.now(),
      done: true,
    };
    store.upsertEntry(entry);
    this.input.push(userMessage(text));
  }

  private entry(): ConvEntry {
    if (!this.currentEntry) {
      this.currentEntry = {
        id: nextId("msg"),
        role: "orch",
        parts: [],
        at: Date.now(),
        done: false,
      };
    }
    return this.currentEntry;
  }

  private appendText(text: string) {
    const entry = this.entry();
    const last = entry.parts[entry.parts.length - 1];
    if (last && last.t === "text") last.text += text;
    else entry.parts.push({ t: "text", text });
    store.upsertEntry(entry);
  }

  private appendTaskRef(taskId: string) {
    const entry = this.entry();
    entry.parts.push({ t: "task", taskId });
    store.upsertEntry(entry);
  }

  private finishEntry() {
    const entry = this.currentEntry;
    this.currentEntry = null;
    if (!entry) return;
    // suppress silent / empty wake-turn replies
    const text = entry.parts
      .filter((p): p is { t: "text"; text: string } => p.t === "text")
      .map((p) => p.text)
      .join("")
      .trim();
    const hasTasks = entry.parts.some((p) => p.t === "task");
    if (!hasTasks && (text === "" || text === "[silent]")) {
      store.removeEntry(entry.id);
      return;
    }
    if (text === "[silent]" && hasTasks) {
      entry.parts = entry.parts.filter((p) => p.t !== "text");
    }
    entry.done = true;
    store.upsertEntry(entry);
  }

  private systemNote(text: string) {
    store.upsertEntry({
      id: nextId("msg"),
      role: "system",
      parts: [{ t: "text", text }],
      at: Date.now(),
      done: true,
    });
  }

  private tools() {
    const spawnTask = tool(
      "spawn_task",
      "Spawn a coding-agent task. Returns the task id. The task appears as a live card in the conversation.",
      {
        title: z
          .string()
          .describe(
            "Conventional-commit style card title: type(scope): summary. e.g. 'fix(r2): bound retry schedule in bucket tests'",
          ),
        brief: z
          .string()
          .describe(
            "Full brief for the worker agent: context, the goal, constraints, how to verify, when to ask the user.",
          ),
        cwd: z
          .string()
          .optional()
          .describe("Working directory (absolute, or relative to the workspace root). Defaults to the workspace root."),
        autonomy: z
          .enum(["safe", "full"])
          .optional()
          .describe(
            "'safe' (default): gated commands surface to the user for approval. 'full': run without permission prompts — only when the user asked for it.",
          ),
      },
      async (args) => {
        if (!taskManager.isValidTitle(args.title)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Invalid title "${args.title}". It must match conventional-commit format: type(scope): summary`,
              },
            ],
            isError: true,
          };
        }
        const cwd = args.cwd
          ? path.resolve(WORKSPACE_ROOT, args.cwd)
          : WORKSPACE_ROOT;
        const card = taskManager.create({
          title: args.title,
          brief: args.brief,
          cwd,
          autonomy: args.autonomy ?? "safe",
        });
        this.appendTaskRef(card.id);
        return {
          content: [
            {
              type: "text" as const,
              text: `Spawned task ${card.id} ("${card.title}") in ${cwd}. Its card is now visible to the user.`,
            },
          ],
        };
      },
    );

    const messageTask = tool(
      "message_task",
      "Send a message into a task's thread (steering, follow-ups, or relaying the user's answer).",
      { id: z.string(), message: z.string() },
      async (args) => {
        const ok = taskManager.message(args.id, args.message, "dispatch");
        return {
          content: [
            { type: "text" as const, text: ok ? "Delivered." : `No such task: ${args.id}` },
          ],
          isError: !ok,
        };
      },
    );

    const readTask = tool(
      "read_task",
      "Read a task's current card state and the tail of its thread. Use before reporting on a task.",
      {
        id: z.string(),
        last: z.number().optional().describe("How many transcript entries to include (default 15)"),
      },
      async (args) => {
        const card = taskManager.get(args.id);
        if (!card) {
          return {
            content: [{ type: "text" as const, text: `No such task: ${args.id}` }],
            isError: true,
          };
        }
        const tail = card.transcript
          .slice(-(args.last ?? 15))
          .map((t) => `[${t.role}] ${t.text}`)
          .join("\n");
        return {
          content: [
            {
              type: "text" as const,
              text: `${JSON.stringify(cardBrief(card), null, 2)}\n\nthread tail:\n${tail || "(empty)"}`,
            },
          ],
        };
      },
    );

    const listTasks = tool(
      "list_tasks",
      "Snapshot of every task's card state. Use for status digests.",
      {},
      async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(taskManager.list().map(cardBrief), null, 2) || "[]",
          },
        ],
      }),
    );

    const stopTask = tool(
      "stop_task",
      "Stop a running task.",
      { id: z.string() },
      async (args) => {
        const ok = await taskManager.stop(args.id);
        return {
          content: [
            { type: "text" as const, text: ok ? "Stopped." : `No such task: ${args.id}` },
          ],
          isError: !ok,
        };
      },
    );

    return [spawnTask, messageTask, readTask, listTasks, stopTask];
  }

  private async run() {
    const session = query({
      prompt: this.input.iterable,
      options: {
        cwd: WORKSPACE_ROOT,
        systemPrompt: ORCHESTRATOR_PROMPT,
        includePartialMessages: true,
        // dispatch tools are allowlisted below; anything else is denied here
        canUseTool: async () => ({
          behavior: "deny",
          message: "You are the orchestrator — delegate via spawn_task instead.",
        }),
        mcpServers: {
          dispatch: createSdkMcpServer({
            name: "dispatch",
            version: "1.0.0",
            tools: this.tools(),
          }),
        },
        allowedTools: [
          "mcp__dispatch__spawn_task",
          "mcp__dispatch__message_task",
          "mcp__dispatch__read_task",
          "mcp__dispatch__list_tasks",
          "mcp__dispatch__stop_task",
        ],
      },
    });

    try {
      for await (const message of session) {
        const m = message as Record<string, any>;
        if (m.type === "stream_event") {
          const event = m.event;
          if (
            event?.type === "content_block_delta" &&
            event.delta?.type === "text_delta" &&
            typeof event.delta.text === "string"
          ) {
            this.appendText(event.delta.text);
          }
        } else if (m.type === "result") {
          this.finishEntry();
        }
      }
      this.systemNote("Orchestrator session ended.");
    } catch (error) {
      this.finishEntry();
      this.systemNote(
        `Orchestrator crashed: ${truncate(String(error), 300)} — is the \`claude\` CLI installed and logged in?`,
      );
    }
  }
}

export const orchestrator = new Orchestrator();
