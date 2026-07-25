/**
 * The org's CHAT PROJECTION of kernel runs — the bridge between the
 * kernel's observability seam and the Vercel AI SDK's UI protocol
 * (designs/ai/streaming.md):
 *
 * - one kernel RUN (term + key) = one CHAT, id `${term}:${key}`;
 * - the kernel's `KernelObservation` log is the canonical record —
 *   per-run, seq-ordered, ring-buffered in memory;
 * - `messages(id)` REDUCES a log into AI SDK `UIMessage[]` (the
 *   snapshot a client loads before tailing);
 * - `subscribe(id)` hands a subscriber the live tail (backlog from a
 *   seq cursor + a queue of new observations) — the snapshot+tail
 *   pattern every surveyed harness uses;
 * - `toChunks` translates observations into `UIMessageChunk`s: one
 *   run-burst = one assistant message, one sampling = one step.
 */
import type { UIMessage, UIMessageChunk, UIMessagePart } from "ai";
import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

/** Chat identity: one kernel run. */
export interface ChatSummary {
  readonly id: string;
  readonly term: string;
  readonly key: string;
  /** `running` = actively sampling; `idle` = parked until the world moves. */
  readonly status: "running" | "idle" | "settled" | "crashed";
  /** Samplings so far (assistant observations). */
  readonly ticks: number;
  /** When the run was admitted — the story orders by this. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The chat id of the run that dispatched this one, if any. */
  readonly parent: string | undefined;
  /** The run's FIRST input (truncated) — the work item it was born with. */
  readonly firstInput: string | undefined;
}

interface ChatState {
  readonly term: string;
  readonly key: string;
  status: "running" | "idle" | "settled" | "crashed";
  ticks: number;
  readonly createdAt: number;
  updatedAt: number;
  parent: string | undefined;
  firstInput: string | undefined;
  /**
   * The IN-FLIGHT sampling, accumulated from `assistant-delta` and
   * live `tool-call` observations — transient (never logged): the
   * final `assistant` observation restates the whole sampling and
   * clears this. Live tool calls matter most: a dispatch's handler
   * (a subagent) may run for minutes before the sampling completes.
   */
  streaming:
    | {
        tick: number;
        text: string;
        reasoning: string;
        toolCalls: Array<{ id: string; name: string; input: unknown }>;
      }
    | undefined;
  /** Ring buffer of observations (last MAX_LOG). */
  log: Array<AI.KernelObservation>;
  readonly subscribers: Set<Queue.Queue<AI.KernelObservation>>;
}

const MAX_LOG = 2000;

export const chatId = (term: string, key: string) => `${term}:${key}`;

export class Chats extends Context.Service<
  Chats,
  {
    /** Feed one kernel observation into the projection. */
    readonly ingest: (
      observation: AI.KernelObservation,
    ) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<ChatSummary>>;
    /** The chat's transcript as AI SDK UIMessages, or undefined. */
    readonly messages: (
      id: string,
    ) => Effect.Effect<ReadonlyArray<UIMessage> | undefined>;
    /**
     * Live tail: backlog (observations with `seq > since`) plus a
     * queue of everything after. Registers even for chats that have
     * not been admitted yet (subscribe-then-trigger races). The
     * caller MUST run `unsubscribe` when done — tie it to the
     * response stream's lifetime, not the request scope.
     */
    readonly subscribe: (
      id: string,
      since?: number,
    ) => Effect.Effect<{
      readonly backlog: ReadonlyArray<AI.KernelObservation>;
      readonly queue: Queue.Queue<AI.KernelObservation>;
      readonly unsubscribe: Effect.Effect<void>;
    }>;
  }
>()("alchemy-org/Chats") {}

export const ChatsLive = Layer.effect(
  Chats,
  Effect.sync(() => {
    const chats = new Map<string, ChatState>();

    const ensure = (term: string, key: string): ChatState => {
      const id = chatId(term, key);
      let chat = chats.get(id);
      if (chat === undefined) {
        chat = {
          term,
          key,
          status: "running",
          ticks: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          parent: undefined,
          firstInput: undefined,
          streaming: undefined,
          log: [],
          subscribers: new Set(),
        };
        chats.set(id, chat);
      }
      return chat;
    };

    return {
      ingest: (observation) =>
        Effect.gen(function* () {
          const chat = ensure(observation.term, observation.key);
          // token slices + live tool calls are the live view, not the
          // record: accumulate transiently (a rare provider retry may
          // replay a tick's prefix — the final `assistant` observation
          // supersedes it)
          if (
            observation.type === "assistant-delta" ||
            observation.type === "tool-call"
          ) {
            if (chat.streaming?.tick !== observation.tick) {
              chat.streaming = {
                tick: observation.tick,
                text: "",
                reasoning: "",
                toolCalls: [],
              };
            }
            if (observation.type === "assistant-delta") {
              chat.streaming[observation.channel] += observation.delta;
            } else if (
              !chat.streaming.toolCalls.some(
                (call) => call.id === observation.toolCallId,
              )
            ) {
              chat.streaming.toolCalls.push({
                id: observation.toolCallId,
                name: observation.toolName,
                input: observation.input,
              });
            }
            chat.updatedAt = observation.at;
            return;
          }
          if (observation.type === "assistant") chat.streaming = undefined;
          chat.log.push(observation);
          if (chat.log.length > MAX_LOG) chat.log.splice(0, MAX_LOG / 4);
          chat.updatedAt = observation.at;
          if (observation.type === "admitted" && observation.parent) {
            chat.parent = chatId(
              observation.parent.term,
              observation.parent.key,
            );
          }
          if (observation.type === "input" && chat.firstInput === undefined) {
            chat.firstInput = observation.text.slice(0, 4000);
          }
          if (observation.type === "assistant") chat.ticks++;
          // the working/waiting line: parked = idle until the next
          // input wakes it (settled/crashed runs emit nothing after)
          if (observation.type === "parked") chat.status = "idle";
          if (observation.type === "input") chat.status = "running";
          if (observation.type === "settled") chat.status = "settled";
          if (observation.type === "crashed") chat.status = "crashed";
          for (const subscriber of chat.subscribers) {
            yield* Queue.offer(subscriber, observation);
          }
        }),
      list: () =>
        Effect.sync(() =>
          [...chats.entries()]
            .map(([id, chat]) => ({
              id,
              term: chat.term,
              key: chat.key,
              status: chat.status,
              ticks: chat.ticks,
              createdAt: chat.createdAt,
              updatedAt: chat.updatedAt,
              parent: chat.parent,
              firstInput: chat.firstInput,
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        ),
      messages: (id) =>
        Effect.sync(() => {
          const chat = chats.get(id);
          if (chat === undefined) return undefined;
          const messages = reduceMessages(chat.log);
          // the in-flight sampling rides along as a streaming-state
          // assistant message: pollers render tokens as they accumulate
          const streaming = chat.streaming;
          if (
            streaming !== undefined &&
            (streaming.text.length > 0 ||
              streaming.reasoning.length > 0 ||
              streaming.toolCalls.length > 0)
          ) {
            const parts: Array<UIMessagePart<any, any>> = [];
            if (streaming.reasoning.length > 0) {
              parts.push({
                type: "reasoning",
                text: streaming.reasoning,
                state: "streaming",
              });
            }
            if (streaming.text.length > 0) {
              parts.push({
                type: "text",
                text: streaming.text,
                state: "streaming",
              });
            }
            for (const call of streaming.toolCalls) {
              parts.push({
                type: "dynamic-tool",
                toolName: call.name,
                toolCallId: call.id,
                state: "input-available",
                input: call.input,
              } as never);
            }
            messages.push({
              id: `live-${streaming.tick}`,
              role: "assistant",
              parts,
            });
          }
          return messages;
        }),
      subscribe: (id, since) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AI.KernelObservation>();
          const at = id.indexOf(":");
          const chat =
            chats.get(id) ??
            (at > 0 ? ensure(id.slice(0, at), id.slice(at + 1)) : undefined);
          const backlog =
            chat === undefined
              ? []
              : since === undefined
                ? [...chat.log]
                : chat.log.filter((observation) => observation.seq > since);
          chat?.subscribers.add(queue);
          return {
            backlog,
            queue,
            unsubscribe: Effect.sync(() => {
              chat?.subscribers.delete(queue);
            }),
          };
        }),
    };
  }),
);

/** The kernel seam: observations flow straight into the projection. */
export const ChatsObserverLive: Layer.Layer<AI.KernelObserver, never, Chats> =
  Layer.effect(
    AI.KernelObserver,
    Effect.gen(function* () {
      const chats = yield* Chats;
      return { emit: chats.ingest };
    }),
  );

// ─── the board: issue channels + the agents they dispatched ─────────

/** One agent thread on the board. */
export interface BoardThread extends ChatSummary {
  /** Human label — "Engineer", "Reviewer", "PR #59", … */
  readonly label: string;
}

export interface BoardIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed" | "unknown";
  readonly updatedAt: number;
  /** The issue's CHANNEL chat — the thread you open when you click
   *  the issue. Undefined until the channel has been admitted. */
  readonly channel: string | undefined;
  /** Agents the channel dispatched (chronological) — the UI links a
   *  dispatch card in the channel to its worker thread through this. */
  readonly agents: Array<BoardThread>;
}

export interface Board {
  readonly issues: Array<BoardIssue>;
  /** Threads that belong to no issue (unlinked PRs, factory, …). */
  readonly other: Array<BoardThread>;
}

/** Best-effort parse of a chat's first input as a GitHub event. */
const parseEvent = (
  firstInput: string | undefined,
): { issue?: any; pullRequest?: any } => {
  if (firstInput === undefined) return {};
  try {
    const parsed = JSON.parse(firstInput);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};

/**
 * Group the flat chat list into the ISSUE BOARD. A `Channel` run
 * keyed `owner/repo#n` anchors issue `n`; kernel parentage (the
 * `admitted` observation's dispatch edge) collects the workers it
 * dispatched, chronological. Roots that anchor no issue (the
 * unlinked-PR desk, factory waves, Discord) land in `other`.
 * GitHub's open-issues list (when available) supplies titles/state
 * for issues with no channel yet.
 */
export const buildBoard = (
  chats: ReadonlyArray<ChatSummary>,
  openIssues:
    | ReadonlyArray<{ readonly number: number; readonly title: string }>
    | undefined,
): Board => {
  const byParent = new Map<string, Array<ChatSummary>>();
  for (const chat of chats) {
    if (chat.parent === undefined) continue;
    const siblings = byParent.get(chat.parent) ?? [];
    siblings.push(chat);
    byParent.set(chat.parent, siblings);
  }

  /** Every descendant a root dispatched (the root excluded), flat. */
  const descendants = (chat: ChatSummary): Array<ChatSummary> =>
    (byParent.get(chat.id) ?? []).flatMap((child) => [
      child,
      ...descendants(child),
    ]);

  const label = (chat: ChatSummary): string => {
    if (chat.term === "PullRequestReviewer") {
      return `PR #${chat.key.match(/#(\d+)$/)?.[1] ?? "?"}`;
    }
    return chat.term;
  };

  const issues = new Map<
    number,
    {
      title: string;
      state: BoardIssue["state"];
      channel: string | undefined;
      updatedAt: number;
      agents: Array<ChatSummary>;
    }
  >();
  const ensureIssue = (number: number) => {
    let issue = issues.get(number);
    if (issue === undefined) {
      issue = {
        title: `#${number}`,
        state: "unknown",
        channel: undefined,
        updatedAt: 0,
        agents: [],
      };
      issues.set(number, issue);
    }
    return issue;
  };
  for (const open of openIssues ?? []) {
    const issue = ensureIssue(open.number);
    issue.title = open.title;
    issue.state = "open";
  }

  const other: Array<ChatSummary> = [];
  for (const chat of chats) {
    if (chat.parent !== undefined) continue; // reachable via its root
    const threadNumber = Number(chat.key.match(/#(\d+)$/)?.[1]);
    if (chat.term === "Channel" && Number.isFinite(threadNumber)) {
      const issue = ensureIssue(threadNumber);
      const event = parseEvent(chat.firstInput);
      if (event.issue?.title) issue.title = event.issue.title;
      if (issue.state === "unknown" && openIssues !== undefined) {
        issue.state = "closed"; // fetched the open list; not on it
      }
      issue.channel = chat.id;
      const workers = descendants(chat);
      issue.updatedAt = Math.max(
        chat.updatedAt,
        ...workers.map((worker) => worker.updatedAt),
      );
      issue.agents.push(...workers);
    } else {
      other.push(chat, ...descendants(chat));
    }
  }

  /** Chronological + labeled, with ordinals when a label repeats. */
  const present = (threads: Array<ChatSummary>): Array<BoardThread> => {
    const seen = new Map<string, number>();
    return threads
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((chat) => {
        const base = label(chat);
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        return { ...chat, label: count === 1 ? base : `${base} (${count})` };
      });
  };

  const boardIssues = [...issues.entries()]
    .map(([number, issue]) => ({
      number,
      title: issue.title,
      state: issue.state,
      updatedAt: issue.updatedAt,
      channel: issue.channel,
      agents: present(issue.agents),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    issues: boardIssues,
    other: present(other).reverse(),
  };
};

// ─── log → UIMessage[] (the snapshot) ────────────────────────────────

/**
 * Reduce a run's observation log into AI SDK UIMessages: inputs are
 * user messages; a BURST of samplings (everything between inputs) is
 * one assistant message whose parts are step-start + text +
 * dynamic-tool parts, with tool results upgrading their call's state.
 */
const reduceMessages = (
  log: ReadonlyArray<AI.KernelObservation>,
): Array<UIMessage> => {
  const messages: Array<UIMessage> = [];
  let assistant: { message: UIMessage; parts: Array<UIMessagePart<any, any>> } | undefined;
  const toolParts = new Map<string, any>();

  for (const observation of log) {
    switch (observation.type) {
      case "input": {
        assistant = undefined;
        messages.push({
          id: `u-${observation.seq}`,
          role: "user",
          parts: [{ type: "text", text: observation.text }],
        });
        break;
      }
      case "assistant": {
        if (assistant === undefined) {
          const parts: Array<UIMessagePart<any, any>> = [];
          const message: UIMessage = {
            id: `a-${observation.seq}`,
            role: "assistant",
            parts,
          };
          assistant = { message, parts };
          messages.push(message);
        }
        assistant.parts.push({ type: "step-start" });
        if (
          observation.reasoning !== undefined &&
          observation.reasoning.length > 0
        ) {
          assistant.parts.push({
            type: "reasoning",
            text: observation.reasoning,
            state: "done",
          });
        }
        if (observation.text.length > 0) {
          assistant.parts.push({ type: "text", text: observation.text });
        }
        for (const call of observation.toolCalls) {
          const part = {
            type: "dynamic-tool" as const,
            toolName: call.name,
            toolCallId: call.id,
            state: "input-available" as const,
            input: call.input,
          };
          toolParts.set(call.id, part);
          assistant.parts.push(part);
        }
        break;
      }
      case "tool-result": {
        const part = toolParts.get(observation.toolCallId);
        if (part !== undefined) {
          part.state = observation.isFailure
            ? "output-error"
            : "output-available";
          if (observation.isFailure) {
            part.errorText = String(observation.output);
          } else {
            part.output = observation.output;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return messages;
};

// ─── live observations → UIMessageChunk (the tail) ──────────────────

/**
 * A stateful translator from a run's live observations to AI SDK
 * UIMessageChunks: emits `start` once, wraps each sampling in
 * `start-step`/`finish-step`, and reports whether the response is
 * COMPLETE (quiescence, settle, or crash) so the HTTP edge knows when
 * to say `finish` and close.
 */
export const makeChunkTranslator = () => {
  let started = false;
  let openStep = false;

  return (
    observation: AI.KernelObservation,
  ): { chunks: Array<UIMessageChunk>; done: boolean } => {
    const chunks: Array<UIMessageChunk> = [];
    let done = false;

    const closeStep = () => {
      if (openStep) {
        chunks.push({ type: "finish-step" });
        openStep = false;
      }
    };

    switch (observation.type) {
      case "assistant": {
        if (!started) {
          chunks.push({ type: "start", messageId: `a-${observation.seq}` });
          started = true;
        }
        closeStep();
        chunks.push({ type: "start-step" });
        openStep = true;
        if (
          observation.reasoning !== undefined &&
          observation.reasoning.length > 0
        ) {
          const reasoningId = `r-${observation.seq}`;
          chunks.push({ type: "reasoning-start", id: reasoningId });
          chunks.push({
            type: "reasoning-delta",
            id: reasoningId,
            delta: observation.reasoning,
          });
          chunks.push({ type: "reasoning-end", id: reasoningId });
        }
        if (observation.text.length > 0) {
          const textId = `t-${observation.seq}`;
          chunks.push({ type: "text-start", id: textId });
          chunks.push({
            type: "text-delta",
            id: textId,
            delta: observation.text,
          });
          chunks.push({ type: "text-end", id: textId });
        }
        for (const call of observation.toolCalls) {
          chunks.push({
            type: "tool-input-available",
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
            dynamic: true,
          });
        }
        // quiescence ends the burst — the assistant message is complete
        if (observation.toolCalls.length === 0) {
          closeStep();
          chunks.push({ type: "finish" });
          done = true;
        }
        break;
      }
      case "tool-result": {
        chunks.push(
          observation.isFailure
            ? {
                type: "tool-output-error",
                toolCallId: observation.toolCallId,
                errorText: String(observation.output),
                dynamic: true,
              }
            : {
                type: "tool-output-available",
                toolCallId: observation.toolCallId,
                output: observation.output,
                dynamic: true,
              },
        );
        break;
      }
      case "settled": {
        closeStep();
        // a stream must resolve cleanly even when the run ended
        // before producing anything (e.g. steering a settled run)
        if (!started) chunks.push({ type: "start" });
        chunks.push({ type: "finish" });
        done = true;
        break;
      }
      case "crashed": {
        closeStep();
        if (!started) chunks.push({ type: "start" });
        chunks.push({ type: "error", errorText: observation.error });
        chunks.push({ type: "finish" });
        done = true;
        break;
      }
      default:
        break;
    }
    return { chunks, done };
  };
};
