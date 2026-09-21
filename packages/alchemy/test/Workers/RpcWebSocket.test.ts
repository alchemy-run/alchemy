import {
  makeHandlers,
  RpcActivationScope,
} from "@/Workers/RpcDurableObject.ts";
import * as Protocol from "@/Workers/RpcWebSocket.ts";
import {
  readRpcMetadata,
  writeRpcMetadata,
} from "@/Workers/WebSocketAttachment.ts";
import { expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup, RpcSerialization } from "effect/unstable/rpc";

const socket = (initial: unknown = null) =>
  Effect.gen(function* () {
    const messages = yield* Queue.unbounded<string>();
    return yield* Effect.sync(() => {
      let attachment = initial;
      const closes: number[] = [];
      const value: Protocol.Socket = {
        ws: {},
        send: (message) =>
          Queue.offer(messages, String(message)).pipe(Effect.asVoid),
        close: (code) =>
          Effect.sync(() => {
            closes.push(code);
          }),
        serializeAttachment: (value) => {
          attachment = value;
        },
        deserializeAttachment: <T>() => attachment as T | null,
      };
      return {
        value,
        closes,
        metadata: () => readRpcMetadata(attachment),
        receive: Queue.take(messages).pipe(
          Effect.map((message) => JSON.parse(message)),
          Effect.timeout("3 seconds"),
        ),
      };
    });
  });

const make = <R = never>(
  sockets: readonly Protocol.Socket[] = [],
  overrides: Partial<Protocol.NativeAdapter<Protocol.Socket, R>> = {},
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let heartbeat: { request: string; response: string } | null = null;
    const pins: Fiber.Fiber<void>[] = [];
    const transport = yield* Protocol.make({
      sockets: Effect.succeed(sockets),
      waitUntil: (effect) =>
        effect.pipe(
          Effect.forkIn(scope),
          Effect.tap((fiber) =>
            Effect.sync(() => {
              pins.push(fiber);
            }),
          ),
          Effect.asVoid,
        ),
      abort: (reason) => Effect.die(new Error(reason)),
      heartbeat: {
        get: Effect.sync(() => heartbeat),
        set: (pair) =>
          Effect.sync(() => {
            heartbeat = pair ?? null;
          }),
      },
      ...overrides,
    }).pipe(Effect.provide(RpcSerialization.layerJson));
    return { transport, pins, heartbeat: () => heartbeat };
  });

const request = (id: string, tag: string, payload: unknown = {}) =>
  JSON.stringify({
    _tag: "Request",
    id,
    tag,
    payload,
    headers: [],
  });

it.effect(
  "accepts native connections and persists pending metadata before dispatch",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket("application");
      const { transport, heartbeat } = yield* make();
      const observed: unknown[] = [];
      yield* transport.protocol
        .run((_id, message) =>
          Effect.sync(() => {
            observed.push({
              tag: message._tag,
              metadata: connection.metadata(),
            });
          }),
        )
        .pipe(Effect.forkScoped);
      expect(yield* transport.accept(connection.value)).toBe(true);
      expect(heartbeat()).not.toBeNull();
      yield* transport.webSocketMessage(connection.value, request("1", "echo"));
      expect(observed).toMatchObject([
        { tag: "Request", metadata: { pending: true } },
      ]);
      expect(heartbeat()).toBeNull();
      yield* transport.webSocketMessage(
        connection.value,
        JSON.stringify({ _tag: "Ack", requestId: "1" }),
      );
      yield* transport.webSocketMessage(
        connection.value,
        JSON.stringify({ _tag: "Interrupt", requestId: "1" }),
      );
      expect(observed.map((entry: any) => entry.tag)).toEqual([
        "Request",
        "Ack",
        "Interrupt",
      ]);
    }).pipe(Effect.scoped),
);

it.effect(
  "restores idle metadata on the same native socket without replay",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket();
      const first = yield* make();
      const fiber = yield* first.transport.protocol
        .run(() => Effect.void)
        .pipe(Effect.forkScoped);
      yield* first.transport.accept(connection.value);
      yield* Fiber.interrupt(fiber);
      expect(connection.closes).toEqual([]);
      const second = yield* make([connection.value]);
      const seen: unknown[] = [];
      yield* second.transport.protocol
        .run((_id, value) =>
          Effect.sync(() => {
            seen.push(value);
          }),
        )
        .pipe(Effect.forkScoped);
      yield* second.transport.webSocketMessage(
        connection.value,
        JSON.stringify({ _tag: "Ping" }),
      );
      expect(seen).toEqual([{ _tag: "Ping" }]);
      expect(connection.closes).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "resets pending, incompatible and duplicate identities without dispatch",
  () =>
    Effect.gen(function* () {
      const metadata = {
        version: 1,
        clientId: 0,
        pending: false,
        serialization: RpcSerialization.json.contentType,
      };
      const pending = yield* socket(
        writeRpcMetadata(null, { ...metadata, pending: true }),
      );
      const incompatible = yield* socket(
        writeRpcMetadata(null, { ...metadata, version: 2 }),
      );
      const valid = yield* socket(writeRpcMetadata(null, metadata));
      const duplicate = yield* socket(writeRpcMetadata(null, metadata));
      yield* make([
        pending.value,
        incompatible.value,
        valid.value,
        duplicate.value,
      ]);
      expect(pending.closes).toEqual([1012]);
      expect(incompatible.closes).toEqual([1012]);
      expect(duplicate.closes).toEqual([1012]);
      expect(valid.closes).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "accept restores native sockets delivered after activation construction and never overwrites pending metadata",
  () =>
    Effect.gen(function* () {
      const metadata = {
        version: 1,
        clientId: 7,
        pending: false,
        serialization: RpcSerialization.json.contentType,
      };
      const idle = yield* socket(writeRpcMetadata("session", metadata));
      const pending = yield* socket(
        writeRpcMetadata(null, { ...metadata, clientId: 8, pending: true }),
      );
      const incompatible = yield* socket(
        writeRpcMetadata(null, { ...metadata, clientId: 9, version: 2 }),
      );
      const malformed = yield* socket(writeRpcMetadata(null, undefined));
      const { transport } = yield* make();
      yield* transport.protocol.run(() => Effect.void).pipe(Effect.forkScoped);
      expect(yield* transport.accept(idle.value)).toBe(true);
      expect(idle.metadata()).toEqual(metadata);
      for (const connection of [pending, incompatible, malformed]) {
        expect(yield* transport.accept(connection.value)).toBe(false);
        expect(connection.closes).toEqual([1012]);
      }
      expect(pending.metadata()).toMatchObject({ pending: true });
    }).pipe(Effect.scoped),
);

it.effect(
  "durable allocation cannot collide with sockets restored after a fresh connection",
  () =>
    Effect.gen(function* () {
      let nextId = 0;
      const allocateClientId = Effect.sync(() => nextId++);
      const a = yield* socket();
      const b = yield* socket();
      const c = yield* socket();
      const first = yield* make([], { allocateClientId });
      yield* first.transport.protocol
        .run(() => Effect.void)
        .pipe(Effect.forkScoped);
      yield* first.transport.accept(a.value);
      yield* first.transport.accept(b.value);
      yield* first.transport.retire;
      const second = yield* make([], { allocateClientId });
      yield* second.transport.protocol
        .run(() => Effect.void)
        .pipe(Effect.forkScoped);
      expect(yield* second.transport.accept(a.value)).toBe(true);
      expect(yield* second.transport.accept(c.value)).toBe(true);
      expect(yield* second.transport.accept(b.value)).toBe(true);
      expect(a.metadata()).toMatchObject({ clientId: 0 });
      expect(b.metadata()).toMatchObject({ clientId: 1 });
      expect(c.metadata()).toMatchObject({ clientId: 2 });
      expect([...a.closes, ...b.closes, ...c.closes]).toEqual([]);
    }).pipe(Effect.scoped),
);

it.effect(
  "asynchronous native persistence completes before an RPC can mutate state",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket();
      const flushing = yield* Deferred.make<void>();
      const persisted = yield* Deferred.make<void>();
      let dispatched = false;
      const { transport } = yield* make([], {
        flush: () =>
          Schema.is(Schema.Struct({ pending: Schema.Literal(true) }))(
            connection.metadata(),
          )
            ? Deferred.succeed(flushing, undefined).pipe(
                Effect.andThen(Deferred.await(persisted)),
              )
            : Effect.void,
      });
      yield* transport.protocol
        .run(() =>
          Effect.sync(() => {
            dispatched = true;
          }),
        )
        .pipe(Effect.forkScoped);
      yield* transport.accept(connection.value);
      const delivery = yield* transport
        .webSocketMessage(connection.value, request("1", "mutate"))
        .pipe(Effect.forkScoped);
      yield* Deferred.await(flushing);
      expect(dispatched).toBe(false);
      yield* Deferred.succeed(persisted, undefined);
      yield* Fiber.join(delivery);
      expect(dispatched).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect(
  "native idle metadata is durable before exclusive heartbeat can resume",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket();
      const other = yield* socket();
      const flushing = yield* Deferred.make<void>();
      const durable = yield* Deferred.make<void>();
      let clearing = false;
      const { transport, heartbeat } = yield* make([], {
        flush: (candidate) =>
          clearing && candidate.ws === connection.value.ws
            ? Deferred.succeed(flushing, undefined).pipe(
                Effect.andThen(Deferred.await(durable)),
              )
            : Effect.void,
      });
      yield* transport.protocol.run(() => Effect.void).pipe(Effect.forkScoped);
      yield* transport.accept(connection.value);
      yield* transport.webSocketMessage(connection.value, request("1", "echo"));
      clearing = true;
      const response = yield* transport.protocol
        .send(0, {
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: null },
        })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(flushing);
      yield* transport.accept(other.value);
      expect(heartbeat()).toBeNull();
      yield* Deferred.succeed(durable, undefined);
      yield* Fiber.join(response);
      expect(heartbeat()).not.toBeNull();
    }).pipe(Effect.scoped),
);

class Calls extends RpcGroup.make(
  Rpc.make("echo", {
    payload: { value: Schema.String },
    success: Schema.String,
  }),
  Rpc.make("numbers", { success: Schema.Number, stream: true }),
) {}

class Invocation extends Context.Service<Invocation, string>()(
  "RpcTestInvocation",
) {}

it.effect(
  "concurrent native invocations retain their own context through handlers, persistence and finalizers",
  () =>
    Effect.gen(function* () {
      const first = yield* socket();
      const second = yield* socket();
      const release = yield* Deferred.make<void>();
      const started = yield* Queue.unbounded<string>();
      const observations: { phase: string; invocation: string }[] = [];
      const { transport, pins } = yield* make([], {
        flush: () =>
          Invocation.pipe(
            Effect.flatMap((invocation) =>
              Effect.sync(() => {
                observations.push({ phase: "flush", invocation });
              }),
            ),
          ),
      }).pipe(Effect.provideService(Invocation, "initialization"));
      const activation = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(activation, Exit.void));
      const handlers = yield* makeHandlers(
        Calls,
        Calls.toLayer({
          echo: () =>
            Effect.gen(function* () {
              const invocation = yield* Invocation;
              yield* Queue.offer(started, invocation);
              yield* Effect.addFinalizer(() =>
                Invocation.pipe(
                  Effect.flatMap((current) =>
                    Effect.sync(() => {
                      observations.push({
                        phase: "finalizer",
                        invocation: current,
                      });
                    }),
                  ),
                ),
              );
              yield* Deferred.await(release);
              return invocation;
            }),
          numbers: () => Stream.empty,
        }),
        { transport: Effect.succeed(transport), http: false },
      ).pipe(
        Effect.provideService(RpcActivationScope, activation),
        Effect.provideService(Invocation, "initialization"),
      );
      expect(handlers.webSocketOpen).toBe(transport.accept);
      yield* handlers.webSocketOpen!(first.value).pipe(
        Effect.provideService(Invocation, "open"),
      );
      yield* handlers.webSocketOpen!(second.value).pipe(
        Effect.provideService(Invocation, "open"),
      );
      yield* transport
        .webSocketMessage(
          first.value,
          request("1", "echo", { value: "ignored" }),
        )
        .pipe(Effect.provideService(Invocation, "one"));
      yield* transport
        .webSocketMessage(
          second.value,
          request("1", "echo", { value: "ignored" }),
        )
        .pipe(Effect.provideService(Invocation, "two"));
      expect(
        new Set([yield* Queue.take(started), yield* Queue.take(started)]),
      ).toEqual(new Set(["one", "two"]));
      yield* Deferred.succeed(release, undefined);
      expect(yield* first.receive).toMatchObject({ exit: { value: "one" } });
      expect(yield* second.receive).toMatchObject({ exit: { value: "two" } });
      yield* Effect.forEach(pins, Fiber.join);
      expect(
        observations
          .filter((entry) => entry.phase === "finalizer")
          .map((entry) => entry.invocation)
          .sort(),
      ).toEqual(["one", "two"]);
      expect(
        observations.filter((entry) => entry.invocation === "initialization"),
      ).toEqual([]);
      expect(
        observations.filter(
          (entry) => entry.phase === "flush" && entry.invocation === "one",
        ),
      ).toHaveLength(2);
      expect(
        observations.filter(
          (entry) => entry.phase === "flush" && entry.invocation === "two",
        ),
      ).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect(
  "activation scope retirement retains idle sockets and pending recovery metadata before server shutdown",
  () =>
    Effect.gen(function* () {
      const idle = yield* socket();
      const pending = yield* socket();
      const { transport, pins } = yield* make();
      const activation = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(activation, Exit.void));
      const finalized = yield* Deferred.make<void>();
      yield* makeHandlers(
        Calls,
        Calls.toLayer({
          echo: ({ value }) => Effect.succeed(value),
          numbers: () =>
            Stream.concat(Stream.make(1), Stream.never).pipe(
              Stream.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        }),
        { transport: Effect.succeed(transport), http: false },
      ).pipe(Effect.provideService(RpcActivationScope, activation));
      yield* transport.accept(idle.value);
      yield* transport.accept(pending.value);
      yield* transport.webSocketMessage(
        idle.value,
        request("1", "echo", { value: "idle" }),
      );
      yield* idle.receive;
      yield* Effect.forEach([...pins], Fiber.join);
      yield* transport.webSocketMessage(
        pending.value,
        request("1", "numbers", null),
      );
      expect(yield* pending.receive).toMatchObject({
        _tag: "Chunk",
        values: [1],
      });
      yield* Scope.close(activation, Exit.void).pipe(
        Effect.timeout("3 seconds"),
      );
      yield* Deferred.await(finalized);
      expect(idle.closes).toEqual([]);
      expect(pending.closes).toEqual([]);
      expect(idle.metadata()).toMatchObject({ pending: false });
      expect(pending.metadata()).toMatchObject({ pending: true });
      const restored = yield* make([idle.value, pending.value]);
      yield* restored.transport.protocol
        .run(() => Effect.void)
        .pipe(Effect.forkScoped);
      expect(idle.closes).toEqual([]);
      expect(pending.closes).toEqual([1012]);
      expect(yield* restored.transport.accept(idle.value)).toBe(true);
    }).pipe(Effect.scoped),
);

it.effect(
  "retains pending recovery metadata through RPC scope finalizers",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket();
      const { transport, heartbeat, pins } = yield* make();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const activation = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(activation, Exit.void));
      yield* makeHandlers(
        Calls,
        Calls.toLayer({
          echo: ({ value }) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(Deferred.succeed(finished, undefined)),
                ),
              );
              return value;
            }),
          numbers: () => Stream.empty,
        }),
        { transport: Effect.succeed(transport), http: false },
      ).pipe(Effect.provideService(RpcActivationScope, activation));
      yield* transport.accept(connection.value);
      yield* transport.webSocketMessage(
        connection.value,
        request("1", "echo", { value: "ok" }),
      );
      expect(yield* connection.receive).toMatchObject({
        _tag: "Exit",
        requestId: "1",
      });
      yield* Deferred.await(started).pipe(Effect.timeout("3 seconds"));
      expect(connection.metadata()).toMatchObject({ pending: true });
      expect(heartbeat()).toBeNull();
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      yield* Fiber.join(pins[1]!);
      expect(connection.metadata()).toMatchObject({ pending: false });
      expect(heartbeat()).not.toBeNull();
    }).pipe(Effect.scoped),
);

it.effect(
  "streams incrementally, handles Interrupt, and keeps the socket usable",
  () =>
    Effect.gen(function* () {
      const connection = yield* socket();
      const { transport } = yield* make();
      const finalized = yield* Deferred.make<void>();
      const activation = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(activation, Exit.void));
      yield* makeHandlers(
        Calls,
        Calls.toLayer({
          echo: ({ value }) => Effect.succeed(value),
          numbers: () =>
            Stream.concat(Stream.make(1), Stream.never).pipe(
              Stream.ensuring(Deferred.succeed(finalized, undefined)),
            ),
        }),
        { transport: Effect.succeed(transport), http: false },
      ).pipe(Effect.provideService(RpcActivationScope, activation));
      yield* transport.accept(connection.value);
      yield* transport.webSocketMessage(
        connection.value,
        request("1", "numbers", null),
      );
      expect(yield* connection.receive).toMatchObject({
        _tag: "Chunk",
        requestId: "1",
        values: [1],
      });
      yield* transport.webSocketMessage(
        connection.value,
        JSON.stringify({ _tag: "Interrupt", requestId: "1" }),
      );
      yield* Deferred.await(finalized).pipe(Effect.timeout("3 seconds"));
      expect(yield* connection.receive).toMatchObject({
        _tag: "Exit",
        requestId: "1",
      });
      yield* transport.webSocketMessage(
        connection.value,
        request("2", "echo", { value: "still-open" }),
      );
      expect(yield* connection.receive).toMatchObject({
        _tag: "Exit",
        requestId: "2",
        exit: { _tag: "Success", value: "still-open" },
      });
      expect(connection.closes).toEqual([]);
    }).pipe(Effect.scoped),
);
