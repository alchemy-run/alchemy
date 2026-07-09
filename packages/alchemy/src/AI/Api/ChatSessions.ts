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
import type { RuntimeContext } from "../../RuntimeContext.ts";
import { type AskAnswer, AskHub, type PendingAsk } from "../Ask.ts";
import type { KernelError } from "../Errors.ts";
import { Kernel, type KernelEvent } from "../Kernel.ts";
import type { ProcessService } from "../Process.ts";
import { chunksToMessage, toChunks } from "./Chunks.ts";
import {
  messageText,
  type UIMessage,
  type UIMessageChunk,
} from "./Protocol.ts";

export interface ChatSessionsService {
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

export const makeChatSessions = (options: {
  /** The interpreted process term the conversations drive. */
  readonly process: Pick<ProcessService<any, any, any>, "send">;
  /** How a user message becomes the ring's work item. @default messageText */
  readonly toItem?: (message: UIMessage) => unknown;
}): Effect.Effect<ChatSessionsService, never, Kernel | AskHub> =>
  Effect.gen(function* () {
    const kernel = yield* Kernel;
    const askHub = yield* AskHub;
    const toItem = options.toItem ?? messageText;
    const transcripts = new Map<string, UIMessage[]>();

    const appendTo = (conversationId: string, message: UIMessage) => {
      const existing = transcripts.get(conversationId) ?? [];
      transcripts.set(conversationId, [...existing, message]);
    };

    return {
      transcript: (conversationId) =>
        Effect.sync(() => transcripts.get(conversationId) ?? []),

      send: (conversationId, message) =>
        Stream.unwrap(
          Effect.gen(function* () {
            appendTo(conversationId, message);
            const item = toItem(message);
            // subscribe BEFORE admitting so the run.admitted row (and
            // every delta after it) is already flowing into the window
            const events = yield* Stream.toQueue(kernel.events, {
              capacity: "unbounded",
            });
            yield* Effect.yieldNow;
            yield* options.process.send(item);
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
 * carrying our item, then follow that session to its halt. The ring is
 * serial, so between admission and halt the session filter is exact.
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
        return event.session === session;
      }),
      Stream.takeUntil((event) => event.type === "turn.halted"),
    );
  };
