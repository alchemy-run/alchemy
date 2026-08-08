/**
 * The CHAT PROJECTION of driver sessions — the materialized view every UI
 * over the driver needs (designs/ai/streaming.md): one driver SESSION
 * (term + key) = one CHAT, id `${term}:${key}`; the driver's
 * {@link SessionObservation} log is the canonical record — per-session,
 * seq-ordered, ring-buffered; `subscribe` is the snapshot+tail
 * pattern every surveyed harness uses.
 *
 * The projection is deliberately PROTOCOL-NEUTRAL: it stores and
 * serves driver vocabulary (observations, summaries, the in-flight
 * sampling). Rendering into a UI protocol is an adapter's job — see
 * `UIMessage.ts` for the Vercel AI SDK shaping.
 *
 * Same per-environment-physics pattern as every org seam:
 * {@link ChatsMemory} for a single process today; a Durable Object or
 * sqlite implementation slots in behind the same contract when sessions
 * must survive their host.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { SessionObserver, type SessionObservation } from "./Observer.ts";

/** Chat identity: one driver session. */
export interface ChatSummary {
  readonly id: string;
  readonly term: string;
  readonly key: string;
  /** `running` = actively sampling; `idle` = parked until the world moves. */
  readonly status: "running" | "idle" | "settled" | "crashed";
  /** Samplings so far (assistant observations). */
  readonly ticks: number;
  /** When the session was admitted. */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The chat id of the session that dispatched this one, if any. */
  readonly parent: string | undefined;
  /** The session's FIRST input (truncated) — the work item it was born with. */
  readonly firstInput: string | undefined;
}

/**
 * The IN-FLIGHT sampling, accumulated from `assistant-delta` and live
 * `tool-call` observations — transient (never logged): the final
 * `assistant` observation restates the whole sampling and clears
 * this. Live tool calls matter most: a dispatch's handler (a
 * subagent) may run for minutes before the sampling completes.
 */
export interface StreamingSample {
  readonly tick: number;
  readonly text: string;
  readonly reasoning: string;
  readonly toolCalls: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }>;
}

/** A chat's full state: the canonical log + the in-flight sampling. */
export interface ChatSnapshot {
  readonly log: ReadonlyArray<SessionObservation>;
  readonly streaming: StreamingSample | undefined;
}

export const chatId = (term: string, key: string) => `${term}:${key}`;

export class Chats extends Context.Service<
  Chats,
  {
    /** Feed one driver observation into the projection. */
    readonly ingest: (observation: SessionObservation) => Effect.Effect<void>;
    readonly list: () => Effect.Effect<ReadonlyArray<ChatSummary>>;
    /** The chat's canonical log + in-flight sampling, or undefined. */
    readonly snapshot: (id: string) => Effect.Effect<ChatSnapshot | undefined>;
    /**
     * Live tail: backlog (observations with `seq > since`) plus a
     * queue of everything after. Registers even for chats that have
     * not been admitted yet (subscribe-then-trigger races). The
     * caller MUST session `unsubscribe` when done — tie it to the
     * response stream's lifetime, not the request scope.
     */
    readonly subscribe: (
      id: string,
      since?: number,
    ) => Effect.Effect<{
      readonly backlog: ReadonlyArray<SessionObservation>;
      readonly queue: Queue.Queue<SessionObservation>;
      readonly unsubscribe: Effect.Effect<void>;
    }>;
  }
>()("alchemy/AI/Chats") {}

/**
 * The driver seam: observations flow straight into the projection.
 * Provide alongside the driver Layer, over ONE shared {@link Chats}
 * instance (the same const the HTTP surface reads — layers memoize by
 * reference).
 */
export const ChatsObserver: Layer.Layer<SessionObserver, never, Chats> =
  Layer.effect(
    SessionObserver,
    Effect.gen(function* () {
      const chats = yield* Chats;
      return { emit: chats.ingest };
    }),
  );

export interface ChatsMemoryOptions {
  /** Ring-buffer size per chat (oldest quarter evicted on overflow). @default 2000 */
  readonly maxLog?: number;
  /** Bytes of the first input retained on the summary. @default 4000 */
  readonly firstInputBytes?: number;
}

interface ChatState {
  readonly term: string;
  readonly key: string;
  status: ChatSummary["status"];
  ticks: number;
  readonly createdAt: number;
  updatedAt: number;
  parent: string | undefined;
  firstInput: string | undefined;
  streaming:
    | {
        tick: number;
        text: string;
        reasoning: string;
        toolCalls: Array<{ id: string; name: string; input: unknown }>;
      }
    | undefined;
  log: Array<SessionObservation>;
  readonly subscribers: Set<Queue.Queue<SessionObservation>>;
}

/** In-memory physics: a single process's projection. */
export const ChatsMemory = (options?: ChatsMemoryOptions): Layer.Layer<Chats> =>
  Layer.effect(
    Chats,
    Effect.sync(() => {
      const maxLog = options?.maxLog ?? 2000;
      const firstInputBytes = options?.firstInputBytes ?? 4000;
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
            // token slices + live tool calls are the live view, not
            // the record: accumulate transiently (a rare provider
            // retry may replay a tick's prefix — the final
            // `assistant` observation supersedes it)
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
            if (chat.log.length > maxLog) chat.log.splice(0, maxLog / 4);
            chat.updatedAt = observation.at;
            if (observation.type === "admitted" && observation.parent) {
              chat.parent = chatId(
                observation.parent.term,
                observation.parent.key,
              );
            }
            if (observation.type === "input" && chat.firstInput === undefined) {
              chat.firstInput = observation.text.slice(0, firstInputBytes);
            }
            if (observation.type === "assistant") chat.ticks++;
            // the working/waiting line: parked = idle until the next
            // input wakes it (settled/crashed sessions emit nothing after)
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
        snapshot: (id) =>
          Effect.sync(() => {
            const chat = chats.get(id);
            if (chat === undefined) return undefined;
            return { log: [...chat.log], streaming: chat.streaming };
          }),
        subscribe: (id, since) =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<SessionObservation>();
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
