/**
 * The serving tier's conversation registry (designs/ai/serving.md §2):
 * `conversationId → UIMessage[]`, a **materialized view** of kernel
 * facts. The kernel stays session-free — a conversation is a
 * serving-tier notion, and the transcript's two halves are both
 * derivable from the Trace (user message = the `run.admitted` item,
 * assistant message = the run's rows folded into parts).
 *
 * `send` is the one path (§3): append the user message, **admit** the
 * item to the process ring (never a blocking call — the run executes on
 * the ring's fiber), and return the run's chunk window. The window is
 * correlated by watching the firehose for the admission's
 * `run.admitted` row and then following that session to its halt; when
 * the window closes, the collected chunks materialize into the
 * assistant `UIMessage` and land in the transcript. A dropped window
 * therefore never loses the message — the transcript is written from
 * what the fold saw, and a reconnect can rebuild from the Trace.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Prompt from "effect/unstable/ai/Prompt";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { type AskAnswer, AskHub, type PendingAsk } from "../Ask.ts";
import type { KernelError } from "../Errors.ts";
import { Kernel, type KernelEvent } from "../Kernel.ts";
import type { ProcessService } from "../Process.ts";
import { chunksToMessage, inRun, toChunks } from "./Chunks.ts";
import {
  messageText,
  type UIMessage,
  type UIMessageChunk,
} from "./Protocol.ts";

export interface ConversationSummary {
  readonly id: string;
  /** The first user message's text — the sidebar label. */
  readonly title: string;
  readonly messages: number;
}

/** The serving-boundary input to a target-specific conversation adapter. */
export interface ChatTargetInput {
  readonly conversationId: string;
  readonly history: ReadonlyArray<UIMessage>;
  readonly message: UIMessage;
}

/**
 * A typed route from UI conversation data to one process's domain input.
 *
 * `ChatSessions` internally stores heterogeneous targets, but callers
 * construct each target through `chatTarget`, which proves that its
 * adapter returns exactly the `In` accepted by its ProcessService. This
 * is the boundary the old `processes: Record<string, ProcessService<any,
 * any, any>>` erased, forcing coordinators to stringify raw
 * `Prompt.Message[]`.
 */
export interface ChatTarget<In> {
  readonly process: Pick<ProcessService<any, In, any>, "send">;
  readonly toItem: (input: ChatTargetInput) => In;
}

export const chatTarget = <In>(
  process: Pick<ProcessService<any, In, any>, "send">,
  toItem: (input: ChatTargetInput) => In,
): ChatTarget<In> => ({ process, toItem });

export interface ChatSessionsService {
  /** The conversation index (insertion order). */
  readonly conversations: Effect.Effect<ReadonlyArray<ConversationSummary>>;
  /** The materialized transcript for one conversation. */
  transcript(conversationId: string): Effect.Effect<ReadonlyArray<UIMessage>>;
  /**
   * Append the user message, admit its item to the ring, and window the
   * run as protocol chunks. The assistant message lands in the
   * transcript when the run halts, whether or not the window is still
   * attached.
   */
  send(
    conversationId: string,
    message: UIMessage,
  ): Stream.Stream<UIMessageChunk, never, RuntimeContext>;
  /** Asks currently parked (the answering side's inbox). */
  readonly asks: Effect.Effect<ReadonlyArray<PendingAsk>>;
  /** Deliver a correlated answer to a parked ask. */
  answer(id: string, answer: AskAnswer): Effect.Effect<void, KernelError>;
}

export class ChatSessions extends Context.Service<
  ChatSessions,
  ChatSessionsService
>()("alchemy/AI/Api/ChatSessions") {}

/**
 * The default work item: the CONVERSATION, not the last message. The
 * kernel is session-free — a run's world state rides in its work item
 * (§2.8) — so the serving tier must put the transcript there or every
 * turn starts amnesiac ("do it again" → "do what?"). Prior turns
 * become role-tagged messages (text parts only — tool mechanics live
 * in the Trace, not the conversational memory).
 */
export const conversationItem = (
  history: ReadonlyArray<UIMessage>,
  message: UIMessage,
): unknown => {
  const turns = [...history, message]
    .filter((entry) => entry.role === "user" || entry.role === "assistant")
    .map((entry) => ({ role: entry.role, text: messageText(entry) }))
    .filter((entry) => entry.text.length > 0);
  // a single first message stays a plain string (the common case, and
  // what run.admitted rows and delegation summaries render best)
  if (turns.length === 1 && turns[0]!.role === "user") {
    return turns[0]!.text;
  }
  return turns.map((turn) =>
    Prompt.makeMessage(turn.role as "user" | "assistant", {
      content: [Prompt.makePart("text", { text: turn.text })] as never,
    }),
  );
};

export const makeChatSessions = (options: {
  /**
   * The interpreted process term(s) the conversations drive. With a
   * single handle every conversation targets it. With a map, the
   * conversation id's first `/`-segment routes: `general/post-1` →
   * `processes.general`, `dm:Sage/main` → `processes["dm:Sage"]` —
   * the org-chat shape (a channel per target, an agent per DM).
   */
  readonly process?: Pick<ProcessService<any, any, any>, "send">;
  readonly processes?: Record<
    string,
    Pick<ProcessService<any, any, any>, "send">
  >;
  /**
   * Typed target routes. Prefer this over `processes` whenever a process
   * has a domain input (`PostThread`, `IssueWorkItem`, …) rather than the
   * default conversational Prompt messages.
   */
  readonly targets?: Record<string, ChatTarget<any>>;
  /**
   * How a conversation becomes the ring's work item.
   * @default conversationItem (full history + new message)
   */
  readonly toItem?: (
    history: ReadonlyArray<UIMessage>,
    message: UIMessage,
  ) => unknown;
}): Effect.Effect<ChatSessionsService, never, Kernel | AskHub> =>
  Effect.gen(function* () {
    const kernel = yield* Kernel;
    const askHub = yield* AskHub;
    const toItem = options.toItem ?? conversationItem;
    const transcripts = new Map<string, UIMessage[]>();

    const routeTo = (conversationId: string) => {
      const targetName = conversationId.split("/")[0]!;
      const target = options.targets?.[targetName];
      if (target !== undefined) return target;
      if (options.processes !== undefined) {
        const process = options.processes[targetName];
        if (process !== undefined) {
          return chatTarget(process, ({ history, message }) =>
            toItem(history, message),
          );
        }
      }
      if (options.process !== undefined) {
        return chatTarget(options.process, ({ history, message }) =>
          toItem(history, message),
        );
      }
      throw new Error(
        `no process for conversation ${JSON.stringify(conversationId)} — ` +
          `expected its first /-segment to name one of: ` +
          `${Object.keys(options.processes ?? {}).join(", ")}`,
      );
    };

    const appendTo = (conversationId: string, message: UIMessage) => {
      const existing = transcripts.get(conversationId) ?? [];
      transcripts.set(conversationId, [...existing, message]);
    };

    return {
      conversations: Effect.sync(() =>
        [...transcripts.entries()].map(([id, messages]) => ({
          id,
          title:
            messages
              .find((message) => message.role === "user")
              ?.parts.filter((part) => part.type === "text")
              .map((part) => String((part as { text?: unknown }).text ?? ""))
              .join("") ?? id,
          messages: messages.length,
        })),
      ),

      transcript: (conversationId) =>
        Effect.sync(() => transcripts.get(conversationId) ?? []),

      send: (conversationId, message) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // history BEFORE this message — toItem composes both
            const target = routeTo(conversationId);
            const history = transcripts.get(conversationId) ?? [];
            appendTo(conversationId, message);
            const item = target.toItem({
              conversationId,
              history,
              message,
            });
            // subscribe BEFORE admitting so the run.admitted row (and
            // every delta after it) is already flowing into the window
            const events = yield* Stream.toQueue(kernel.events, {
              capacity: "unbounded",
            });
            yield* Effect.yieldNow;
            yield* target.process.send(item);
            const collected: UIMessageChunk[] = [];
            return Stream.fromQueue(events).pipe(
              correlateRun(item),
              toChunks,
              Stream.tap((chunk) => Effect.sync(() => collected.push(chunk))),
              // materialize regardless of whether the window survived
              Stream.ensuring(
                Effect.sync(() =>
                  appendTo(conversationId, chunksToMessage(collected)),
                ),
              ),
            );
          }),
        ),

      asks: askHub.pending,
      answer: (id, answer) => askHub.answer(id, answer),
    } satisfies ChatSessionsService;
  });

/**
 * Correlate a firehose to ONE run: wait for the `run.admitted` row
 * carrying our item, then follow that run (prefix-matched — process
 * runs derive per-iteration sessions) until it settles. The ring is
 * serial, so between admission and settlement the filter is exact.
 */
const correlateRun =
  (item: unknown) =>
  <E>(events: Stream.Stream<KernelEvent, E>): Stream.Stream<KernelEvent, E> => {
    let session: string | undefined;
    return events.pipe(
      Stream.filter((event) => {
        if (session === undefined) {
          if (
            event.type === "run.admitted" &&
            (event.payload as { item?: unknown } | undefined)?.item === item
          ) {
            session = event.session;
            return true;
          }
          return false;
        }
        return inRun(event, session);
      }),
      Stream.takeUntil((event) => event.type === "run.settled"),
    );
  };
