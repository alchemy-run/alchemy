/**
 * The Chats projection on Cloudflare — a singleton Durable Object that
 * every run DO and the HTTP Worker share. `ChatsMemory` is per-isolate;
 * this is the board's source of truth so `/api/board` sees admissions
 * that happened inside AgentRuns.
 *
 * Run DOs reach it through {@link ChatsObserver} → `chats.ingest` (RPC).
 * The Worker HTTP surface `yield* Chats` for `list` / `snapshot`. Live
 * per-run transcripts stay on the run socket (`/attach`); this DO holds
 * summaries + a ring-buffered log for the board and initial hydrate.
 */
import {
  Chats,
  chatId,
  type ChatSnapshot,
  type ChatSummary,
  type StreamingSample,
} from "../../AI/Chats.ts";
import type { RunObservation } from "../../AI/Observer.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type { MainRpc } from "../../Platform.ts";
import { DurableObject } from "../Workers/DurableObject.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import type { Worker } from "../Workers/Worker.ts";

const INDEX = "index";
const chatKey = (id: string) => `chat:${id}`;

interface StoredChat {
  readonly term: string;
  readonly key: string;
  status: ChatSummary["status"];
  ticks: number;
  readonly createdAt: number;
  updatedAt: number;
  parent: string | undefined;
  firstInput: string | undefined;
  streaming: StreamingSample | undefined;
  log: Array<RunObservation>;
}

const MAX_LOG = 2000;
const FIRST_INPUT_BYTES = 4000;

const applyObservation = (
  chat: StoredChat,
  observation: RunObservation,
): StoredChat => {
  const next: StoredChat = {
    ...chat,
    log: [...chat.log],
    streaming: chat.streaming
      ? {
          ...chat.streaming,
          toolCalls: [...chat.streaming.toolCalls],
        }
      : undefined,
  };

  if (
    observation.type === "assistant-delta" ||
    observation.type === "tool-call"
  ) {
    if (next.streaming?.tick !== observation.tick) {
      next.streaming = {
        tick: observation.tick,
        text: "",
        reasoning: "",
        toolCalls: [],
      };
    }
    if (observation.type === "assistant-delta") {
      const streaming = next.streaming!;
      next.streaming = {
        tick: streaming.tick,
        text:
          observation.channel === "text"
            ? streaming.text + observation.delta
            : streaming.text,
        reasoning:
          observation.channel === "reasoning"
            ? streaming.reasoning + observation.delta
            : streaming.reasoning,
        toolCalls: streaming.toolCalls,
      };
    } else if (
      !next.streaming!.toolCalls.some(
        (call) => call.id === observation.toolCallId,
      )
    ) {
      next.streaming = {
        ...next.streaming!,
        toolCalls: [
          ...next.streaming!.toolCalls,
          {
            id: observation.toolCallId,
            name: observation.toolName,
            input: observation.input,
          },
        ],
      };
    }
    next.updatedAt = observation.at;
    return next;
  }

  if (observation.type === "assistant") next.streaming = undefined;
  next.log.push(observation);
  if (next.log.length > MAX_LOG) next.log.splice(0, MAX_LOG / 4);
  next.updatedAt = observation.at;
  if (observation.type === "admitted" && observation.parent) {
    next.parent = chatId(observation.parent.term, observation.parent.key);
  }
  if (observation.type === "input" && next.firstInput === undefined) {
    next.firstInput = observation.text.slice(0, FIRST_INPUT_BYTES);
  }
  if (observation.type === "assistant") next.ticks++;
  if (observation.type === "parked") next.status = "idle";
  if (observation.type === "input") next.status = "running";
  if (observation.type === "settled") next.status = "settled";
  if (observation.type === "crashed") next.status = "crashed";
  return next;
};

const toSummary = (id: string, chat: StoredChat): ChatSummary => ({
  id,
  term: chat.term,
  key: chat.key,
  status: chat.status,
  ticks: chat.ticks,
  createdAt: chat.createdAt,
  updatedAt: chat.updatedAt,
  parent: chat.parent,
  firstInput: chat.firstInput,
});

interface ChatsRpc extends MainRpc<DurableObjectState> {
  readonly ingest: (observation: RunObservation) => Effect.Effect<void>;
  readonly list: () => Effect.Effect<ReadonlyArray<ChatSummary>>;
  readonly snapshot: (id: string) => Effect.Effect<ChatSnapshot | undefined>;
}

/**
 * Cloudflare physics for {@link Chats}: one Durable Object (`board`)
 * shared by every run and the HTTP Worker.
 */
export const ChatsCloudflare: Layer.Layer<Chats, never, Worker> = Layer.effect(
  Chats,
  Effect.gen(function* () {
    const namespace = yield* DurableObject<ChatsRpc>()(
      "OrgChats",
      Effect.gen(function* () {
        const state = yield* DurableObjectState;
        const storage = state.storage;
        const sealed = <A, E>(
          effect: Effect.Effect<A, E, RuntimeContext>,
        ): Effect.Effect<A, E> =>
          Effect.provide(effect, RuntimeContext.phantom);

        const readIndex = sealed(
          Effect.map(
            storage.get<string[]>(INDEX).pipe(Effect.orDie),
            (found) => found ?? [],
          ),
        );

        const readChat = (id: string) =>
          sealed(storage.get<StoredChat>(chatKey(id)).pipe(Effect.orDie));

        return Effect.succeed<ChatsRpc>({
          ingest: (observation) =>
            sealed(
              Effect.gen(function* () {
                const id = chatId(observation.term, observation.key);
                const existing = yield* readChat(id);
                const base: StoredChat =
                  existing ??
                  ({
                    term: observation.term,
                    key: observation.key,
                    status: "running",
                    ticks: 0,
                    createdAt: observation.at,
                    updatedAt: observation.at,
                    parent: undefined,
                    firstInput: undefined,
                    streaming: undefined,
                    log: [],
                  } satisfies StoredChat);
                const next = applyObservation(base, observation);
                const index = yield* readIndex;
                const entries: Record<string, unknown> = {
                  [chatKey(id)]: next,
                };
                if (!index.includes(id)) {
                  entries[INDEX] = [...index, id];
                }
                yield* storage.put(entries).pipe(Effect.orDie);
              }),
            ),
          list: () =>
            sealed(
              Effect.gen(function* () {
                const index = yield* readIndex;
                const summaries: Array<ChatSummary> = [];
                for (const id of index) {
                  const chat = yield* readChat(id);
                  if (chat !== undefined) {
                    summaries.push(toSummary(id, chat));
                  }
                }
                return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
              }),
            ),
          snapshot: (id) =>
            sealed(
              Effect.map(readChat(id), (chat) =>
                chat === undefined
                  ? undefined
                  : {
                      log: [...chat.log],
                      streaming: chat.streaming,
                    },
              ),
            ),
        });
      }),
    );

    // getByName is lazy: at plan the namespace is a stub — only
    // runtime calls may address the singleton board instance.
    const board = () => namespace.getByName("board");

    return {
      ingest: (observation) =>
        board().ingest(observation).pipe(Effect.orDie, Effect.asVoid),
      list: () => board().list().pipe(Effect.orDie),
      snapshot: (id) => board().snapshot(id).pipe(Effect.orDie),
      // Live tails belong on the run socket (`/attach`). Directory
      // consumers poll `list`; per-chat HTTP SSE gets the durable
      // backlog and an inert queue (no cross-isolate Queue).
      subscribe: (id, since) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunObservation>();
          const snap = yield* board().snapshot(id).pipe(Effect.orDie);
          const backlog =
            snap === undefined
              ? []
              : since === undefined
                ? [...snap.log]
                : snap.log.filter((observation) => observation.seq > since);
          return {
            backlog,
            queue,
            unsubscribe: Effect.void,
          };
        }),
    } satisfies Chats["Service"];
  }),
);
