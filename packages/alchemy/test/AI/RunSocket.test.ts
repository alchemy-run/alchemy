/**
 * The run-socket protocol on the IN-MEMORY kernel: the same four
 * frames the Cloudflare kernel speaks from a Durable Object, served
 * in-process — `AgentGateway.attach` upgrades a WebSocket on a local
 * Bun HTTP server, replays the run's own observation log from a
 * cursor, and broadcasts live facts as they happen. No cloud, no
 * network beyond localhost, sub-second.
 */
import * as AI from "@/AI/index.ts";
import { KernelMemory } from "@/AI/KernelMemory.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
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
    const frames = yield* Queue.unbounded<AI.RunSocketServerFrame>();
    const write = yield* socket.writer;
    const opened = yield* Deferred.make<void>();

    yield* Effect.forkScoped(
      socket.runString(
        (message) =>
          Queue.offer(frames, JSON.parse(message) as AI.RunSocketServerFrame),
        { onOpen: Deferred.succeed(opened, undefined) },
      ),
    );
    yield* Deferred.await(opened);

    return {
      send: (frame: AI.RunSocketClientFrame) => write(JSON.stringify(frame)),
      next: Queue.take(frames),
    };
  });

const framesUntil = (
  client: { next: Effect.Effect<AI.RunSocketServerFrame, unknown> },
  done: (frame: AI.RunSocketServerFrame) => boolean,
) =>
  Effect.gen(function* () {
    const seen: Array<AI.RunSocketServerFrame> = [];
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

describe("RunSocket (KernelMemory)", () => {
  it.live(
    "the memory kernel serves the identical protocol: submit, live deltas, cursor resume",
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
        const gateway = yield* AI.AgentGateway;

        // an in-process Bun HTTP server routing /attach/:term/:key.
        // The short shutdown budget matters: Bun's graceful stop never
        // resolves for a connection that carried a WebSocket upgrade,
        // so the default would hold teardown for its full 20 seconds.
        const BunHttp = yield* Effect.promise(
          () => import("@effect/platform-bun/BunHttpServer"),
        );
        const server = yield* BunHttp.make({
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
        ) as Array<Extract<AI.RunSocketServerFrame, { type: "observation" }>>;
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
        // `request.upgrade` + response and no kernel code at all.
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
                KernelMemory.pipe(Layer.provide(model.layer)),
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
    "RunSocketTransport end to end: a tool round becomes UIMessageChunks, broadcast reaches every socket",
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
        const gateway = yield* AI.AgentGateway;
        const BunHttp = yield* Effect.promise(
          () => import("@effect/platform-bun/BunHttpServer"),
        );
        const server = yield* BunHttp.make({
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
            const transport = new AI.RunSocketTransport({ url: wsUrl });
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
                KernelMemory.pipe(Layer.provide(model.layer)),
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
});
