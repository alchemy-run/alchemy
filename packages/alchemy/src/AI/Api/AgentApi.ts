/**
 * The serving surface (designs/ai/serving.md §"Surface") as an
 * `HttpRouter` routes Layer — harness-agnostic: serve it from Bun
 * today (`BunHttpServer` + `HttpRouter.serve`), from the Cloudflare
 * Ring DO later, protocol unchanged.
 *
 * - `POST /api/chat` — the AI SDK UI message stream: decode the
 *   `useChat` body, admit the last user message via `ChatSessions`,
 *   window the run as SSE frames (`v1` header, `[DONE]` terminator).
 *   The chat routes hand-frame the SSE deliberately: the AI SDK's
 *   exact framing is a byte-level contract (golden-tested in
 *   `Protocol.ts`), not something to re-derive through a codec.
 * - `GET /api/chat/:id` — the materialized transcript (page load).
 * - `GET /v1/stream/:ring?offset=N` — the durable-streams-shaped
 *   trace window: replay from the cursor, then tail live. Each frame
 *   carries its `seq` as the SSE event id, so `Last-Event-ID`-style
 *   resumption is the same cursor.
 * - `GET /api/asks` / `POST /api/asks/:id` — the Ask control plane.
 * - `POST /api/steer` / `POST /api/interrupt` — process authority.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RuntimeContext } from "../../RuntimeContext.ts";
import { Kernel } from "../Kernel.ts";
import type { ProcessService } from "../Process.ts";
import { topology } from "../Topology.ts";
import { ChatSessions } from "./ChatSessions.ts";
import {
  ChatRequest,
  SSE_DONE,
  SSE_HEADERS,
  sseFrame,
  type UIMessageChunk,
} from "./Protocol.ts";

const AskAnswerBody = S.Struct({
  verdict: S.Literals(["approved", "denied", "answered"]),
  text: S.optionalKey(S.String),
  amendment: S.optionalKey(S.String),
});

const SteerBody = S.Struct({ input: S.String });

export interface AgentApiOptions {
  /**
   * The process handle behind `/api/steer` and `/api/interrupt`.
   * Omit them by omitting this.
   */
  readonly process?: Pick<ProcessService<any, any, any>, "steer" | "interrupt">;
  /**
   * Smooth streaming (the AI SDK `smoothStream` design): providers emit
   * sentence-sized text deltas (Anthropic: 50–80+ chars), which render
   * as stutter-steps. When set, text/reasoning deltas are re-split into
   * word-sized deltas paced this many milliseconds apart, so the UI
   * paints a steady token flow. Off by default (tests and machine
   * consumers want the raw wire).
   */
  readonly smoothing?: { readonly delayMs: number };
  /**
   * Root terms whose `AI.topology` fold is served at `GET
   * /api/topology` — the app's sidebar (org-chat: channels grouped by
   * subkind, agents as DM targets). Derived once at Layer build; terms
   * are static data.
   */
  readonly topology?: ReadonlyArray<unknown>;
}

/** Split a delta into word-sized pieces (whitespace rides its word). */
const splitWords = (delta: string): ReadonlyArray<string> =>
  delta.match(/\S+\s*|\s+/g) ?? [delta];

/**
 * The routes Layer. Serve it with:
 *
 * ```ts
 * HttpRouter.serve(agentApi({ process })).pipe(
 *   Layer.provide(BunHttpServer.layer({ port: 8787 })),
 *   Layer.provide(SessionsLive), // ChatSessions + Kernel + RuntimeContext
 * )
 * ```
 */
export const agentApi = (options: AgentApiOptions = {}) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const sessions = yield* ChatSessions;
      const kernel = yield* Kernel;
      const encoder = new TextEncoder();

      const sse = <E>(frames: Stream.Stream<string, E>) =>
        HttpServerResponse.stream(
          frames.pipe(Stream.map((frame) => encoder.encode(frame))),
          { headers: SSE_HEADERS },
        );

      const smoothing = options.smoothing;
      const smooth =
        smoothing === undefined
          ? (chunks: Stream.Stream<UIMessageChunk>) => chunks
          : (chunks: Stream.Stream<UIMessageChunk>) =>
              chunks.pipe(
                // sequential flatMap: order is preserved; only delta
                // chunks are split and paced, everything else passes
                // through immediately
                Stream.flatMap(
                  (chunk): Stream.Stream<UIMessageChunk> =>
                    // pace TEXT only: thinking can run to thousands of
                    // words, and word-pacing it adds tens of seconds of
                    // artificial playback between the user and the answer
                    chunk.type === "text-delta"
                      ? Stream.fromIterable(splitWords(chunk.delta)).pipe(
                          Stream.map(
                            (word): UIMessageChunk => ({
                              ...chunk,
                              delta: word,
                            }),
                          ),
                          Stream.schedule(
                            Schedule.spaced(Duration.millis(smoothing.delayMs)),
                          ),
                        )
                      : Stream.make(chunk),
                ),
              );

      const chunkWindow = (chunks: Stream.Stream<UIMessageChunk>) =>
        sse(
          smooth(chunks).pipe(
            Stream.map(sseFrame),
            Stream.concat(Stream.make(SSE_DONE)),
          ),
        );

      // ── the chat path: admission + window ────────────────────────
      yield* router.add("POST", "/api/chat", () =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(ChatRequest);
          const conversationId = body.id ?? "default";
          const last = body.messages.at(-1);
          if (last === undefined || last.role !== "user") {
            return HttpServerResponse.text(
              "the last message must be a user message",
              { status: 400 },
            );
          }
          return chunkWindow(
            sessions
              .send(conversationId, last)
              .pipe(Stream.provide(RuntimeContext.phantom)),
          );
        }).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.succeed(
              HttpServerResponse.text(String(error), { status: 400 }),
            ),
          ),
        ),
      );

      yield* router.add("GET", "/api/chats", () =>
        Effect.map(sessions.conversations, (conversations) =>
          HttpServerResponse.jsonUnsafe({ conversations }),
        ),
      );

      // ── the org graph: derived from the term data, never configured ──
      if (options.topology !== undefined) {
        const graph = topology(...options.topology);
        yield* router.add("GET", "/api/topology", () =>
          Effect.succeed(HttpServerResponse.jsonUnsafe({ topology: graph })),
        );
      }

      yield* router.add("GET", "/api/chat/:id", () =>
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const transcript = yield* sessions.transcript(params.id!);
          return HttpServerResponse.jsonUnsafe({ messages: transcript });
        }),
      );

      // ── the trace window: durable-streams-shaped ─────────────────
      // ?offset=N  → replay from the cursor, then tail live (never ends)
      // &limit=M   → bounded backfill: exactly M rows, then the stream
      //              COMPLETES — the scroll-back page, not a tail
      yield* router.add("GET", "/v1/stream/:ring", (request) =>
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const url = new URL(request.url, "http://localhost");
          const offset = Number(url.searchParams.get("offset") ?? "0");
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam === null ? undefined : Number(limitParam);
          const window = kernel.trace(params.ring!, offset);
          return sse(
            (limit === undefined
              ? window
              : window.pipe(Stream.take(limit))
            ).pipe(
              Stream.map(
                (event) =>
                  `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
              // a broken trace read ends the window; the client's cursor
              // (last seen seq) makes the reconnect lossless
              Stream.catch(() => Stream.empty),
            ),
          );
        }),
      );

      // ── the Ask control plane ────────────────────────────────────
      yield* router.add("GET", "/api/asks", () =>
        Effect.map(sessions.asks, (asks) =>
          HttpServerResponse.jsonUnsafe({ asks }),
        ),
      );

      // ask ids derive from command ids and contain `/` — clients send
      // them percent-encoded, the route decodes
      yield* router.add("POST", "/api/asks/:id", () =>
        Effect.gen(function* () {
          const params = yield* HttpRouter.params;
          const answer = yield* HttpServerRequest.schemaBodyJson(AskAnswerBody);
          yield* sessions.answer(decodeURIComponent(params.id!), answer);
          return HttpServerResponse.jsonUnsafe({ ok: true });
        }).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.succeed(
              HttpServerResponse.text(String(error), { status: 400 }),
            ),
          ),
          Effect.catchTag("AI.KernelError", (error) =>
            Effect.succeed(
              HttpServerResponse.text(error.message, { status: 404 }),
            ),
          ),
        ),
      );

      // ── process authority ────────────────────────────────────────
      if (options.process !== undefined) {
        const process = options.process;
        yield* router.add("POST", "/api/steer", () =>
          Effect.gen(function* () {
            const body = yield* HttpServerRequest.schemaBodyJson(SteerBody);
            yield* process
              .steer(body.input)
              .pipe(Effect.provide(RuntimeContext.phantom));
            return HttpServerResponse.jsonUnsafe({ ok: true });
          }).pipe(
            Effect.catchTag("SchemaError", (error) =>
              Effect.succeed(
                HttpServerResponse.text(String(error), { status: 400 }),
              ),
            ),
          ),
        );

        yield* router.add("POST", "/api/interrupt", () =>
          Effect.as(
            process.interrupt().pipe(Effect.provide(RuntimeContext.phantom)),
            HttpServerResponse.jsonUnsafe({ ok: true }),
          ),
        );
      }
    }),
  );
