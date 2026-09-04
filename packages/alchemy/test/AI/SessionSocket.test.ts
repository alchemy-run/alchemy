/**
 * The run-socket protocol on the IN-MEMORY driver: the same four
 * frames the Cloudflare driver speaks from a Durable Object, served
 * in-process — `Sessions.attach` upgrades a WebSocket on a local
 * Bun HTTP server, replays the run's own observation log from a
 * cursor, and broadcasts live facts as they happen. No cloud, no
 * network beyond localhost, sub-second.
 */
import * as AI from "@/AI/index.ts";
import { DriverLocal } from "@/AI/DriverLocal.ts";
import { ThreadStorageMemory } from "@/AI/ThreadStorageMemory.ts";

const InMemoryDriver = DriverLocal.pipe(Layer.provide(ThreadStorageMemory));
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as Socket from "effect/unstable/socket/Socket";
import * as Model from "./fixtures/ScriptedModel.ts";
import {
  Researcher,
  ResearcherCharter,
  Search,
} from "./fixtures/researcher.ts";

/** A connected run-socket client: typed frames in, frames out. */
const connect = (url: string) =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(url);
    const frames = yield* Queue.unbounded<AI.SessionSocketServerFrame>();
    const write = yield* socket.writer;
    const opened = yield* Deferred.make<void>();

    yield* Effect.forkScoped(
      socket.runString(
        (message) =>
          Queue.offer(
            frames,
            JSON.parse(message) as AI.SessionSocketServerFrame,
          ),
        { onOpen: Deferred.succeed(opened, undefined) },
      ),
    );
    yield* Deferred.await(opened);

    return {
      send: (frame: AI.SessionSocketClientFrame) =>
        write(JSON.stringify(frame)),
      next: Queue.take(frames),
    };
  });

const framesUntil = (
  client: { next: Effect.Effect<AI.SessionSocketServerFrame, unknown> },
  done: (frame: AI.SessionSocketServerFrame) => boolean,
) =>
  Effect.gen(function* () {
    const seen: Array<AI.SessionSocketServerFrame> = [];
    while (true) {
      const frame = yield* client.next.pipe(Effect.timeout("10 seconds"));
      seen.push(frame);
      if (done(frame)) return seen;
    }
  });

/** Read an entire UIMessageChunk stream (closes on `finish`). */
const readAll = (stream: ReadableStream<unknown>) =>
  Effect.promise(async () => {
    const chunks: Array<{ type: string; [key: string]: unknown }> = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return chunks;
      chunks.push(value as never);
    }
  });

describe("SessionSocket (DriverLocal)", () => {
  it.live(
    "the memory driver serves the identical protocol: submit, live deltas, cursor resume",
    () => {
      const model = Model.make([
        () => [Model.text("hello from memory"), Model.finish()],
      ]);
      const search = Layer.succeed(Search, ((input: { query: string }) =>
        Effect.succeed(`results for ${input.query}`)) as never);

      return Effect.gen(function* () {
        // resolving the agent's tag interprets it — which registers
        // its socket host with the gateway
        yield* Researcher;
        const gateway = yield* AI.Sessions;

        // an in-process Bun HTTP server routing /attach/:term/:key.
        // The short shutdown budget matters: Bun's graceful stop never
        // resolves for a connection that carried a WebSocket upgrade,
        // so the default would hold teardown for its full 20 seconds.
        const server = yield* BunHttpServer.make({
          port: 0,
          gracefulShutdownTimeout: Duration.millis(100),
        });
        const port =
          server.address._tag === "TcpAddress" ? server.address.port : 0;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            const url = new URL(request.url, "http://local");
            const [, , term, ...rest] = url.pathname.split("/");
            return yield* gateway.attach(term!, rest.join("/"), request);
          }).pipe(Effect.provide(RuntimeContext.phantom)),
        );
        const wsUrl = `ws://localhost:${port}/attach/Researcher/w1`;

        // ── round 1: attach, submit, watch the round stream (a fresh
        // run parks once on creation, so wait for the park AFTER the
        // sampling, not the first one)
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(wsUrl);
            yield* client.send({ type: "submit", input: "say hello" });
            let sawAssistant = false;
            return yield* framesUntil(client, (frame) => {
              if (
                frame.type === "observation" &&
                frame.observation.type === "assistant"
              ) {
                sawAssistant = true;
              }
              return (
                sawAssistant &&
                frame.type === "observation" &&
                frame.durable &&
                frame.observation.type === "parked"
              );
            });
          }),
        );
        const durables = first.filter(
          (frame) => frame.type === "observation" && frame.durable,
        ) as Array<
          Extract<AI.SessionSocketServerFrame, { type: "observation" }>
        >;
        const types = durables.map((frame) => frame.observation.type);
        expect(types).toContain("input");
        expect(types).toContain("assistant");
        // live token deltas streamed mid-sampling, cursor NOT advanced
        expect(
          first.some(
            (frame) =>
              frame.type === "observation" &&
              !frame.durable &&
              frame.observation.type === "assistant-delta",
          ),
        ).toBe(true);
        const seqs = durables.map((frame) => frame.observation.seq);
        expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
        const cursor = seqs[seqs.length - 1]! + 1;

        // ── a second round with NOBODY attached
        const researcher = yield* Researcher;
        yield* researcher.steer("w1", "and again");
        // wait for the round to complete (the run parks again)
        yield* Effect.sleep("300 millis");

        // ── reconnect with the cursor: replay is exactly the gap
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(wsUrl);
            yield* client.send({ type: "subscribe", fromSeq: cursor });
            const replayed = yield* framesUntil(
              client,
              (frame) => frame.type === "live",
            );
            const texts = replayed.flatMap((frame) =>
              frame.type === "observation" && frame.observation.type === "input"
                ? [frame.observation.text]
                : [],
            );
            expect(texts).toContain("and again");
            expect(texts).not.toContain("say hello");
            for (const frame of replayed) {
              if (frame.type === "observation") {
                expect(frame.observation.seq).toBeGreaterThanOrEqual(cursor);
              }
            }
          }),
        );
      }).pipe(
        Effect.scoped,
        // platform-bun wart (v4 beta): a request that carried a
        // WebSocket upgrade leaks a ClientAbort interrupt into the
        // scope's close exit — reproducible with a BARE
        // `request.upgrade` + response and no driver code at all.
        // Every assertion has already run by the time this fires;
        // swallow interrupt-only teardown causes, nothing else.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.failCause(cause),
        ),
        Effect.provide(
          Researcher.make(ResearcherCharter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                InMemoryDriver.pipe(Layer.provide(model.layer)),
                search,
                RuntimeContext.phantom,
              ),
            ),
          ),
        ),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      );
    },
    { timeout: 30_000 },
  );

  it.live(
    "SessionSocketTransport end to end: a tool round becomes UIMessageChunks, broadcast reaches every socket",
    () => {
      // a REAL agentic round: sampling 1 calls the tool, sampling 2
      // answers — exercising the tool-call (live) and tool-result
      // (durable) frames neither protocol test covered
      const model = Model.make([
        () => [
          Model.toolCall("search", { query: "alchemy" }),
          Model.finish("tool-calls"),
        ],
        () => [Model.text("It is IaE."), Model.finish()],
      ]);
      const search = Layer.succeed(Search, ((input: { query: string }) =>
        Effect.succeed(`results for ${input.query}: alchemy is IaE`)) as never);

      return Effect.gen(function* () {
        yield* Researcher;
        const gateway = yield* AI.Sessions;
        const server = yield* BunHttpServer.make({
          port: 0,
          gracefulShutdownTimeout: Duration.millis(100),
        });
        const port =
          server.address._tag === "TcpAddress" ? server.address.port : 0;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            const url = new URL(request.url, "http://local");
            const [, , term, ...rest] = url.pathname.split("/");
            return yield* gateway.attach(term!, rest.join("/"), request);
          }).pipe(Effect.provide(RuntimeContext.phantom)),
        );
        const wsUrl = `ws://localhost:${port}/attach/Researcher/t1`;

        yield* Effect.scoped(
          Effect.gen(function* () {
            // a SECOND socket watches the same run — fan-out proof
            const observer = yield* connect(wsUrl);

            // the CLIENT under test: the exact transport `useChat`
            // runs on, translating observations into UIMessageChunks
            const transport = new AI.SessionSocketTransport({ url: wsUrl });
            const stream = yield* Effect.promise(() =>
              transport.sendMessages({
                trigger: "submit-message",
                chatId: "t1",
                messageId: undefined,
                messages: [
                  {
                    id: "u1",
                    role: "user",
                    parts: [{ type: "text", text: "what is alchemy?" }],
                  },
                ],
                abortSignal: undefined,
              }),
            );
            const chunks = yield* readAll(stream);
            const types = chunks.map((chunk) => chunk.type);

            // the round, in useChat's own vocabulary: message start,
            // the tool call with its input, the tool's OUTPUT (from
            // the durable tool-result frame), the answer, the finish
            expect(types[0]).toBe("start");
            expect(types).toContain("tool-input-available");
            expect(types).toContain("tool-output-available");
            expect(types.at(-1)).toBe("finish");
            const output = chunks.find(
              (chunk) => chunk.type === "tool-output-available",
            )!;
            expect(String(output.output)).toContain("alchemy is IaE");
            const text = chunks.find((chunk) => chunk.type === "text-delta")!;
            expect(text.delta).toBe("It is IaE.");

            // …and the observer socket saw the same round (broadcast
            // is fan-out, not point-to-point)
            let sawAssistant = false;
            const frames = yield* framesUntil(observer, (frame) => {
              if (
                frame.type === "observation" &&
                frame.observation.type === "assistant"
              ) {
                sawAssistant = true;
              }
              return (
                sawAssistant &&
                frame.type === "observation" &&
                frame.observation.type === "parked"
              );
            });
            expect(
              frames.some(
                (frame) =>
                  frame.type === "observation" &&
                  frame.observation.type === "tool-result",
              ),
            ).toBe(true);
          }),
        );
      }).pipe(
        Effect.scoped,
        // same platform-bun teardown wart as above
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.failCause(cause),
        ),
        Effect.provide(
          Researcher.make(ResearcherCharter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                InMemoryDriver.pipe(Layer.provide(model.layer)),
                search,
                RuntimeContext.phantom,
              ),
            ),
          ),
        ),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      );
    },
    { timeout: 30_000 },
  );

  it.live(
    "the transport feeds ONE sink: a submit under an open resume gets its answer; replay surfaces user messages via onInput; Sessions.history is the snapshot",
    () => {
      const model = Model.make([
        () => [Model.text("first answer"), Model.finish()],
      ]);
      const search = Layer.succeed(Search, ((input: { query: string }) =>
        Effect.succeed(`results for ${input.query}`)) as never);

      return Effect.gen(function* () {
        yield* Researcher;
        const gateway = yield* AI.Sessions;
        const server = yield* BunHttpServer.make({
          port: 0,
          gracefulShutdownTimeout: Duration.millis(100),
        });
        const port =
          server.address._tag === "TcpAddress" ? server.address.port : 0;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            const url = new URL(request.url, "http://local");
            const [, , term, ...rest] = url.pathname.split("/");
            return yield* gateway.attach(term!, rest.join("/"), request);
          }).pipe(Effect.provide(RuntimeContext.phantom)),
        );
        const wsUrl = `ws://localhost:${port}/attach/Researcher/s1`;

        // ── exactly what `useChat({ resume: true })` does: hold a
        // resume stream open for the tail, THEN submit. Before the
        // single-sink transport, both streams listened on the socket
        // and the resume (registered first) consumed the burst — the
        // submit's stream never saw its answer.
        const transport = new AI.SessionSocketTransport({ url: wsUrl });
        const echoes: Array<string> = [];
        transport.onInput = (message) =>
          echoes.push(
            message.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          );
        const tail = yield* Effect.promise(() =>
          transport.reconnectToStream({
            chatId: "s1",
            abortSignal: undefined,
          }),
        );
        const turn = yield* Effect.promise(() =>
          transport.sendMessages({
            trigger: "submit-message",
            chatId: "s1",
            messageId: undefined,
            messages: [
              {
                id: "u1",
                role: "user",
                parts: [{ type: "text", text: "first question" }],
              },
            ],
            abortSignal: undefined,
          }),
        );
        const chunks = yield* readAll(turn).pipe(Effect.timeout("10 seconds"));
        const types = chunks.map((chunk) => chunk.type);
        expect(types[0]).toBe("start");
        expect(types.at(-1)).toBe("finish");
        expect(chunks.find((chunk) => chunk.type === "text-delta")!.delta).toBe(
          "first answer",
        );
        // the tail is still pending, unfed — the SDK cancels it on its
        // next resume; and our OWN submit's echo was swallowed
        expect(echoes).toEqual([]);
        yield* Effect.promise(() => tail!.cancel());

        // ── a FRESH client with no snapshot replays the history: the
        // assistant burst arrives as chunks, the user message via
        // onInput — the AI SDK's wire has no user role
        const fresh = new AI.SessionSocketTransport({ url: wsUrl });
        const replayedUsers: Array<{ id: string; text: string }> = [];
        fresh.onInput = (message) =>
          replayedUsers.push({
            id: message.id,
            text: message.parts
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join(""),
          });
        const replay = yield* Effect.promise(() =>
          fresh.reconnectToStream({ chatId: "s1", abortSignal: undefined }),
        );
        const replayed = yield* readAll(replay!).pipe(
          Effect.timeout("10 seconds"),
        );
        expect(
          replayed.find((chunk) => chunk.type === "text-delta")!.delta,
        ).toBe("first answer");
        expect(replayedUsers.map((user) => user.text)).toEqual([
          "first question",
        ]);
        expect(replayedUsers[0]!.id).toMatch(/^u-\d+$/);

        // ── the snapshot agrees with the replay, id for id
        const history = yield* gateway
          .history("Researcher", "s1")
          .pipe(Effect.provide(RuntimeContext.phantom));
        const snapshot = AI.toUIMessages(history);
        expect(snapshot.map((message) => message.role)).toEqual([
          "user",
          "assistant",
        ]);
        expect(snapshot[0]!.id).toBe(replayedUsers[0]!.id);
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.failCause(cause),
        ),
        Effect.provide(
          Researcher.make(ResearcherCharter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                InMemoryDriver.pipe(Layer.provide(model.layer)),
                search,
                RuntimeContext.phantom,
              ),
            ),
          ),
        ),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      );
    },
    { timeout: 30_000 },
  );

  it.live(
    "viewing never waits on the charter's INIT: a session whose init dies still replays, and a submit leaves a durable crash",
    () => {
      // an agent whose per-session init cannot complete — the sandboxed
      // shape (boot the machine, converge the checkout) with the
      // machine wedged. Before the fix `socketHost` built the session
      // first, so `subscribe` hung/died behind the init and the viewer
      // saw an empty transcript.
      class Wedged extends AI.Agent<Wedged>()("Wedged") {}
      const WedgedCharter = Effect.gen(function* () {
        yield* AI.Thread;
        return yield* Effect.die(new Error("machine will not boot"));
      });
      const model = Model.make([() => [Model.text("never"), Model.finish()]]);

      return Effect.gen(function* () {
        yield* Wedged;
        const gateway = yield* AI.Sessions;
        const server = yield* BunHttpServer.make({
          port: 0,
          gracefulShutdownTimeout: Duration.millis(100),
        });
        const port =
          server.address._tag === "TcpAddress" ? server.address.port : 0;
        yield* server.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest;
            const url = new URL(request.url, "http://local");
            const [, , term, ...rest] = url.pathname.split("/");
            return yield* gateway.attach(term!, rest.join("/"), request);
          }).pipe(Effect.provide(RuntimeContext.phantom)),
        );
        const wsUrl = `ws://localhost:${port}/attach/Wedged/w1`;

        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(wsUrl);
            // replay answers from STORAGE alone — no init, no shell:
            // an unknown session is an empty one, `live` at 0
            yield* client.send({ type: "subscribe", fromSeq: 0 });
            const replayed = yield* framesUntil(
              client,
              (frame) => frame.type === "live",
            );
            expect(replayed).toEqual([{ type: "live", seq: 0 }]);

            // the steer builds the session; its init dies — the WHY
            // lands in the transcript as a fatal crash, not silence
            yield* client.send({ type: "submit", input: "hello?" });
            const frames = yield* framesUntil(
              client,
              (frame) =>
                frame.type === "observation" &&
                frame.observation.type === "crashed",
            );
            const crashed = frames.find(
              (frame) =>
                frame.type === "observation" &&
                frame.observation.type === "crashed",
            );
            expect(crashed).toBeDefined();
            if (
              crashed?.type === "observation" &&
              crashed.observation.type === "crashed"
            ) {
              expect(crashed.durable).toBe(true);
              expect(crashed.observation.fatal).toBe(true);
              expect(AI.renderCrash(crashed.observation.error)).toContain(
                "machine will not boot",
              );
            }
          }),
        );

        // a fresh viewer replays the crash from storage — durable
        yield* Effect.scoped(
          Effect.gen(function* () {
            const client = yield* connect(wsUrl);
            yield* client.send({ type: "subscribe", fromSeq: 0 });
            const replayed = yield* framesUntil(
              client,
              (frame) => frame.type === "live",
            );
            const types = replayed.flatMap((frame) =>
              frame.type === "observation" ? [frame.observation.type] : [],
            );
            expect(types).toContain("admitted");
            expect(types).toContain("crashed");
          }),
        );
      }).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.failCause(cause),
        ),
        Effect.provide(
          Wedged.make(WedgedCharter).pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                InMemoryDriver.pipe(Layer.provide(model.layer)),
                RuntimeContext.phantom,
              ),
            ),
          ),
        ),
        Effect.provide(Socket.layerWebSocketConstructorGlobal),
      );
    },
    { timeout: 30_000 },
  );
});
