import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import {
  Greeting,
  Rejected,
  SocketRpcs,
  SocketStats,
} from "./fixtures/rpc-websocket/rpcs.ts";
import SocketWorker from "./fixtures/rpc-websocket/worker.ts";

const Stack = Alchemy.Stack(
  "RpcWebSocketStack",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* SocketWorker;
    return { url: worker.url.as<string>() };
  }),
);

const connect = Effect.fn(function* (url: string) {
  const { socket: raw } = yield* rawConnect(url);
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.effect(Socket.Socket, Socket.fromWebSocket(Effect.succeed(raw))),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const context = yield* Layer.build(protocol);
  const client = yield* RpcClient.make(SocketRpcs).pipe(
    Effect.provide(context),
  );
  return { client, raw };
});

class WebSocketHandshakeFailed extends Data.TaggedError(
  "WebSocketHandshakeFailed",
)<{
  readonly message: string;
}> {}

const rawConnect = Effect.fn(
  function* (url: string) {
    const opened = yield* Deferred.make<void, WebSocketHandshakeFailed>();
    const closed = yield* Deferred.make<{ code: number; reason: string }>();
    const messages = yield* Queue.unbounded<string>();
    const socket = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new WebSocket(url.replace(/^http/, "ws"));
        socket.addEventListener("open", () =>
          Deferred.doneUnsafe(opened, Exit.void),
        );
        socket.addEventListener("error", (event) =>
          Deferred.doneUnsafe(
            opened,
            Exit.fail(
              new WebSocketHandshakeFailed({
                message: `WebSocket handshake failed: ${"message" in event ? event.message : event.type}`,
              }),
            ),
          ),
        );
        socket.addEventListener("message", (event) =>
          Queue.offerUnsafe(messages, String(event.data)),
        );
        socket.addEventListener("close", (event) =>
          Deferred.doneUnsafe(
            closed,
            Exit.succeed({ code: event.code, reason: event.reason }),
          ),
        );
        return socket;
      }),
      (socket) => Effect.sync(() => socket.close()),
    );
    yield* Deferred.await(opened).pipe(
      Effect.timeout("10 seconds"),
      Effect.onError(() => Effect.sync(() => socket.close())),
    );
    const send = (value: unknown) =>
      Effect.sync(() => socket.send(JSON.stringify(value)));
    const receive = Queue.take(messages).pipe(
      Effect.flatMap((value) => Effect.try(() => JSON.parse(value))),
      Effect.timeout("10 seconds"),
    );
    return {
      socket,
      send,
      receive,
      buffered: Queue.size(messages),
      closed: Deferred.await(closed).pipe(Effect.timeout("10 seconds")),
    };
  },
  Effect.retry({
    // Bun hides rejected upgrade responses; retry only before any RPC is sent.
    while: (error) => error._tag === "WebSocketHandshakeFailed",
    schedule: Schedule.spaced("1 second"),
    times: 8,
  }),
);

const readStats = Effect.fn(function* (url: string) {
  const response = yield* requestWorker(HttpClientRequest.get(url));
  if (response.status !== 200) {
    return yield* Effect.fail(
      new Error(`GET ${url}: ${response.status}: ${yield* response.text}`),
    );
  }
  return yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SocketStats)),
  );
}, Effect.timeout("15 seconds"));

describe.concurrent.each([
  { dev: true, stage: "rpc-websocket-local" },
  { dev: false, stage: "rpc-websocket-live" },
])("WebSocket RPC (dev: $dev)", ({ dev, stage }) => {
  const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
    dev,
    stage,
  });
  const stack = beforeAll(
    Effect.gen(function* () {
      yield* destroy(Stack);
      const output = yield* deploy(Stack);
      yield* requestWorker(HttpClientRequest.get(`${output.url}/ready`)).pipe(
        Effect.flatMap((response) =>
          response.text.pipe(
            Effect.flatMap((body) =>
              response.status === 200 && body === "ready"
                ? Effect.void
                : Effect.fail(
                    new Test.WorkerNotReady({ status: response.status }),
                  ),
            ),
          ),
        ),
      );
      yield* rawConnect(`${output.url}/rpc/ready`).pipe(Effect.scoped);
      return output;
    }),
    { timeout: 120_000 },
  );
  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 30_000,
  });

  test(
    "readiness handling preserves application HTTP errors",
    Effect.gen(function* () {
      const { url } = yield* stack;
      for (const [path, status] of [
        ["not-found", 404],
        ["server-error", 500],
      ] as const) {
        const response = yield* requestWorker(
          HttpClientRequest.get(`${url}/${path}`),
        );
        expect(response.status).toBe(status);
        expect(yield* response.text).toBe("application error");
      }
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  test(
    "typed unary, failure, streaming, and HTTP clients share one object",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const { client } = yield* connect(`${url}/rpc/roundtrip`);
      const greeting = yield* client.greet({ name: "Sam" });
      expect(greeting).toBeInstanceOf(Greeting);
      expect(greeting.message).toBe("Hello, Sam!");
      expect(yield* client.increment()).toBe(1);
      expect(yield* client.reject().pipe(Effect.flip)).toBeInstanceOf(Rejected);
      expect(
        yield* client.numbers({ count: 40 }).pipe(Stream.runCollect),
      ).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      const response = yield* requestWorker(
        HttpClientRequest.get(`${url}/stats/roundtrip`),
      );
      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({ count: 1 });
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  test(
    "multiplexes concurrent calls without crossing instance state",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const { client } = yield* connect(`${url}/rpc/concurrent`);
      const results = yield* Effect.all(
        Array.from({ length: 40 }, () => client.increment()),
        { concurrency: "unbounded" },
      );
      expect(results.sort((a, b) => a - b)).toEqual(
        Array.from({ length: 40 }, (_, i) => i + 1),
      );
      const other = yield* connect(`${url}/rpc/isolated`);
      expect((yield* other.client.stats()).count).toBe(0);
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  test(
    "stream interruption closes its scope and keeps the socket usable",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const { client, raw } = yield* connect(`${url}/rpc/interruption`);
      const scope = yield* Scope.make();
      const values = yield* client
        .watch({ key: "cancel" }, { asQueue: true })
        .pipe(Effect.provideService(Scope.Scope, scope));
      expect(yield* Queue.take(values).pipe(Effect.timeout("10 seconds"))).toBe(
        1,
      );
      yield* Scope.close(scope, Exit.void);
      const status = yield* client.stats().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: (state) => state.closed.includes("cancel"),
        }),
      );
      expect(status.closed).toContain("cancel");
      expect(raw.readyState).toBe(WebSocket.OPEN);
      expect((yield* client.greet({ name: "again" })).message).toBe(
        "Hello, again!",
      );
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  test(
    "socket disconnect interrupts active handler resources",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const connection = yield* rawConnect(`${url}/rpc/disconnect`);
      yield* connection.send({
        _tag: "Request",
        id: "1",
        tag: "watch",
        payload: { key: "disconnect" },
        headers: [],
      });
      expect(yield* connection.receive).toMatchObject({
        _tag: "Chunk",
        values: [1],
      });
      yield* Effect.sync(() => connection.socket.close());
      yield* connection.closed;
      const status = yield* requestWorker(
        HttpClientRequest.get(`${url}/stats/disconnect`),
      ).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((state) => state as { closed: string[] }),
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          times: 10,
          until: (state) => state.closed.includes("disconnect"),
        }),
      );
      expect(status).toMatchObject({
        opened: ["disconnect"],
        closed: ["disconnect"],
      });
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  for (const mode of ["unary", "disconnect"] as const) {
    test(
      mode === "unary"
        ? "unary result does not release the activation before deferred cleanup finishes"
        : "disconnect before any output retains the activation until deferred cleanup finishes",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const name = `cleanup-${mode}`;
        const connection = yield* rawConnect(`${url}/rpc/${name}`);
        const before = yield* readStats(`${url}/stats/${name}`);
        yield* Effect.gen(function* () {
          yield* connection.send({
            _tag: "Request",
            id: "1",
            tag: "cleanup",
            payload: { key: mode, waitForDisconnect: mode === "disconnect" },
            headers: [],
          });
          if (mode === "unary") {
            expect(yield* connection.receive).toMatchObject({
              _tag: "Exit",
              requestId: "1",
              exit: { _tag: "Success", value: before.boots },
            });
          } else {
            const entered = yield* readStats(`${url}/stats/${name}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                times: 10,
                until: (state) => state.opened.includes(mode),
              }),
            );
            expect(entered.boots).toBe(before.boots);
            expect(entered.opened).toContain(mode);
            expect(entered.cleanupStarted).toEqual([]);
            expect(yield* connection.buffered).toBe(0);
            yield* Effect.sync(() => connection.socket.close());
            yield* connection.closed;
            expect(yield* connection.buffered).toBe(0);
          }
          const started = yield* readStats(`${url}/stats/${name}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              times: 10,
              until: (state) => state.cleanupStarted.includes(mode),
            }),
          );
          expect(started.boots).toBe(before.boots);
          expect(started.cleanupStarted).toEqual([mode]);
          expect(started.cleanupCompleted).toEqual({});

          // Raw sockets send no heartbeats; only the test process has a timer.
          yield* Effect.sleep("20 seconds");
          const held = yield* readStats(`${url}/stats/${name}`);
          expect(held.boots).toBe(before.boots);
          expect(held.cleanupStarted).toEqual([mode]);
          expect(held.cleanupCompleted).toEqual({});

          if (mode === "unary") {
            expect(connection.socket.readyState).toBe(WebSocket.OPEN);
            const control = yield* rawConnect(`${url}/rpc/${name}`);
            yield* control.send({
              _tag: "Request",
              id: "1",
              tag: "releaseCleanup",
              payload: { key: mode },
              headers: [],
            });
            expect(yield* control.receive).toMatchObject({
              _tag: "Exit",
              requestId: "1",
              exit: { _tag: "Success", value: true },
            });
          } else {
            const response = yield* requestWorker(
              HttpClientRequest.post(`${url}/release/${name}/${mode}`),
            );
            expect(response.status).toBe(200);
            expect(yield* response.json).toEqual({ released: true });
          }
          const completed = yield* readStats(`${url}/stats/${name}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              times: 10,
              until: (state) => state.cleanupCompleted[mode] !== undefined,
            }),
          );
          expect(completed.boots).toBe(before.boots);
          expect(completed.cleanupCompleted).toEqual({ [mode]: before.boots });
        }).pipe(
          Effect.ensuring(
            requestWorker(
              HttpClientRequest.post(`${url}/release/${name}/${mode}`),
            ).pipe(Effect.timeout("15 seconds"), Effect.ignoreCause),
          ),
        );
      }).pipe(Effect.scoped),
      { timeout: 90_000 },
    );
  }

  test(
    "idle connection survives hibernation and serves a new RPC",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const { client, raw } = yield* connect(`${url}/rpc/idle`);
      const before = yield* client.stats();
      const after = yield* Effect.gen(function* () {
        yield* Effect.sleep("20 seconds");
        return yield* client.stats().pipe(Effect.timeout("5 seconds"));
      }).pipe(
        Effect.repeat({
          times: 3,
          until: (state) => state.boots > before.boots,
        }),
      );
      expect(after.boots).toBeGreaterThan(before.boots);
      expect(raw.readyState).toBe(WebSocket.OPEN);
      expect((yield* client.greet({ name: "awake" })).message).toBe(
        "Hello, awake!",
      );
    }).pipe(Effect.scoped),
    { timeout: 110_000 },
  );

  test(
    "native abort fails an active stream without replaying its request",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const connection = yield* rawConnect(`${url}/rpc/lost-stream`);
      yield* connection.send({
        _tag: "Request",
        id: "1",
        tag: "watch",
        payload: { key: "lost" },
        headers: [],
      });
      expect(yield* connection.receive).toMatchObject({
        _tag: "Chunk",
        values: [1],
      });
      yield* connection.send({ _tag: "Ack", requestId: "1" });
      const before = yield* readStats(`${url}/stats/lost-stream`);
      expect(before.invocations).toEqual({ lost: 1 });
      expect(before.opened).toEqual(["lost"]);
      const response = yield* requestWorker(
        HttpClientRequest.post(`${url}/abort/lost-stream`),
      ).pipe(Effect.timeout("15 seconds"));
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({ aborted: true });
      yield* connection.closed;
      expect(connection.socket.readyState).toBe(WebSocket.CLOSED);
      expect(yield* connection.buffered).toBe(0);

      const replacement = yield* connect(`${url}/rpc/lost-stream`);
      const status = yield* replacement.client.stats();
      expect(status.boots).toBeGreaterThan(before.boots);
      expect(status.invocations).toEqual({ lost: 1 });
      expect(status.opened).toEqual([]);
      expect(
        (yield* replacement.client.greet({ name: "reconnected" })).message,
      ).toBe("Hello, reconnected!");
      expect((yield* replacement.client.stats()).invocations).toEqual({
        lost: 1,
      });
    }).pipe(Effect.scoped),
    { timeout: 45_000 },
  );

  test(
    "schema and unknown-method failures leave the connection usable",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const connection = yield* rawConnect(`${url}/rpc/invalid-requests`);
      for (const [id, tag, payload] of [
        ["1", "greet", { name: 42 }],
        ["2", "missing", {}],
      ] as const) {
        yield* connection.send({
          _tag: "Request",
          id,
          tag,
          payload,
          headers: [],
        });
        expect(yield* connection.receive).toMatchObject({
          _tag: "Exit",
          requestId: id,
          exit: { _tag: "Failure" },
        });
      }
      yield* connection.send({
        _tag: "Request",
        id: "3",
        tag: "greet",
        payload: { name: "valid" },
        headers: [],
      });
      expect(yield* connection.receive).toMatchObject({
        _tag: "Exit",
        requestId: "3",
        exit: { _tag: "Success", value: { message: "Hello, valid!" } },
      });
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );

  test(
    "malformed frames close the offending connection",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const connection = yield* rawConnect(`${url}/rpc/malformed`);
      yield* Effect.sync(() => connection.socket.send("not json"));
      expect((yield* connection.closed).code).toBeGreaterThanOrEqual(1002);
      const healthy = yield* connect(`${url}/rpc/malformed`);
      expect((yield* healthy.client.greet({ name: "healthy" })).message).toBe(
        "Hello, healthy!",
      );
    }).pipe(Effect.scoped),
    { timeout: 30_000 },
  );
});
