import { makeCallback } from "@/Callback.ts";
import {
  makeRivetActor,
  type RivetActorFactory,
} from "@/Rivet/DurableObjectBridge.ts";
import {
  DurableObjectState,
  NativeContext,
  type RivetActorContext,
} from "@/Rivet/DurableObjectState.ts";
import {
  makeRivetActorClient,
  parseRivetEndpoint,
  rivetRpcWebSocketUrl,
} from "@/Rivet/Gateway.ts";
import * as RivetRpcWebSocket from "@/Rivet/RpcWebSocket.ts";
import { applyRivetSqlMigrations } from "@/Rivet/SqlMigrations.ts";
import type { SqlMigrationSnapshot } from "@/Workers/SqlMigrationsRuntime.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import { Telemetry } from "@/TelemetryRuntime.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import { makeHandlers } from "@/Workers/RpcDurableObject.ts";
import * as RpcWebSocketClient from "@/Workers/RpcWebSocketClient.ts";
import { WorkerEnvironment, type WorkerBuild } from "@/Workers/Worker.ts";
import { describe, expect, it } from "alchemy-test";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as Socket from "effect/unstable/socket/Socket";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";

class NativeRpcs extends RpcGroup.make(
  Rpc.make("identity", {
    success: Schema.Struct({ actorId: Schema.String, boot: Schema.Number }),
  }),
  Rpc.make("numbers", { success: Schema.Number, stream: true }),
  Rpc.make("hold", { success: Schema.Number }),
) {}
class NativeClient extends Context.Service<
  NativeClient,
  RpcClient.FromGroup<typeof NativeRpcs, RpcClientError>
>()("Rivet.NativeClient") {}

interface NativeActions {
  sleep(): Effect.Effect<void, unknown>;
  schedule(): Effect.Effect<void, unknown>;
  losePreciseWake(): Effect.Effect<void, unknown>;
  migrate(): Effect.Effect<
    { failed: boolean; rows: { id: number }[] },
    unknown
  >;
  status(): Effect.Effect<
    { archived?: boolean; finalized?: boolean; pendingCallbacks: number },
    unknown
  >;
}
const connection = parseRivetEndpoint(
  process.env.RIVET_ENDPOINT ?? "http://127.0.0.1:21130",
);
const Session = Schema.Struct({
  version: Schema.Literal(1),
  user: Schema.String,
});
const migrationSnapshot: SqlMigrationSnapshot = {
  _tag: "Cloudflare.SqlMigrations",
  table: "native_migration_history",
  records: [
    {
      name: "0001_probe.sql",
      hash: "native-proof-0001",
      createdAtMillis: undefined,
      sql: "CREATE TABLE migration_probe(id INTEGER PRIMARY KEY); INSERT INTO migration_probe VALUES (1)",
      statements: [
        "CREATE TABLE migration_probe(id INTEGER PRIMARY KEY)",
        "INSERT INTO migration_probe VALUES (1)",
      ],
    },
    {
      name: "0002_rollback.sql",
      hash: "native-proof-0002",
      createdAtMillis: undefined,
      sql: "INSERT INTO migration_probe VALUES (2); INSERT INTO missing_table VALUES (3)",
      statements: [
        "INSERT INTO migration_probe VALUES (2)",
        "INSERT INTO missing_table VALUES (3)",
      ],
    },
  ],
};

// Opt-in launches the actual Rust engine and native RivetKit, never an in-memory driver.
describe.skipIf(!process.env.ALCHEMY_TEST_RIVET_NATIVE)(
  "Rivet native persistence and WebSockets",
  () => {
    it.live(
      "isolates automatic idle against a native raw-WebSocket control",
      () =>
        Effect.gen(function* () {
          const controlSlept = yield* Deferred.make<void>();
          const providerSlept = yield* Deferred.make<void>();
          const actorIds = new Set<string>();
          const activity = { keepAwake: 0, waitUntil: 0, messages: 0 };
          const instrument = (native: RivetActorContext): RivetActorContext =>
            new Proxy(native, {
              get(target, property) {
                if (property === "keepAwake")
                  return <A>(promise: Promise<A>): Promise<A> => {
                    activity.keepAwake++;
                    return target.keepAwake(
                      Effect.runPromise(
                        Effect.promise(() => promise).pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              activity.keepAwake--;
                            }),
                          ),
                        ),
                      ),
                    );
                  };
                if (property === "waitUntil")
                  return (promise: Promise<unknown>) => {
                    activity.waitUntil++;
                    target.waitUntil(
                      Effect.runPromise(
                        Effect.promise(() => promise).pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              activity.waitUntil--;
                            }),
                          ),
                        ),
                      ),
                    );
                  };
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          const constructor: DurableObjectExport["constructor"] = Effect.gen(
            function* () {
              const state = yield* DurableObjectState;
              return Effect.gen(function* () {
                const boot =
                  ((yield* state.storage.get<number>("boot")) ?? 0) + 1;
                yield* state.storage.put("boot", boot);
                yield* Effect.sync(() => actorIds.add(state.actorId));
                return yield* makeHandlers(
                  NativeRpcs,
                  NativeRpcs.toLayer({
                    identity: () =>
                      Effect.succeed({ actorId: state.actorId, boot }),
                    numbers: () => Stream.make(1),
                    hold: () => Effect.succeed(boot),
                  }),
                  { http: false, transport: RivetRpcWebSocket.make },
                );
              });
            },
          );
          const provider = makeRivetActor(
            ((config) =>
              actor({
                ...config,
                options: { ...config.options, sleepTimeout: 1000 },
                createVars: (native: RivetActorContext) =>
                  config.createVars(instrument(native)),
                onWebSocket: (
                  native: RivetActorContext,
                  socket: Parameters<typeof config.onWebSocket>[1],
                ) => {
                  socket.addEventListener("message", () => {
                    activity.messages++;
                  });
                  return config.onWebSocket(instrument(native), socket);
                },
                onSleep: (native: RivetActorContext) =>
                  Effect.runPromise(
                    Effect.promise(() =>
                      config.onSleep(instrument(native)),
                    ).pipe(
                      Effect.andThen(
                        Deferred.succeed(providerSlept, undefined),
                      ),
                      Effect.asVoid,
                    ),
                  ),
              } as any)) as RivetActorFactory,
            {
              methods: [],
              db: db(),
              build: () =>
                Effect.runPromise(
                  Effect.succeed({
                    context: Context.make(WorkerEnvironment, {}).pipe(
                      Context.add(Telemetry, Layer.empty),
                      Context.add(RuntimeContext, {
                        Type: "Rivet.Worker",
                        id: "idle",
                        env: {},
                        get: () => Effect.succeed(undefined),
                        set: (key) => Effect.succeed(key),
                      }),
                    ),
                    export: {
                      kind: "durableObject",
                      provider: "Rivet",
                      constructor,
                      services: Context.empty(),
                    },
                    shape: () => ({}),
                    telemetry: () => undefined,
                  } satisfies WorkerBuild<DurableObjectExport>),
                ),
            },
          );
          const registry = setup({
            use: {
              IdleProof: provider as ReturnType<typeof actor>,
              IdleControl: actor({
                state: { boot: 0 },
                options: { canHibernateWebSocket: true, sleepTimeout: 1000 },
                createVars: (native) => {
                  native.state.boot++;
                  actorIds.add(native.actorId);
                  return {};
                },
                onWebSocket: (native, socket) => {
                  socket.addEventListener("message", () =>
                    socket.send(
                      JSON.stringify({
                        actorId: native.actorId,
                        boot: native.state.boot,
                        connection: native.conn.id,
                      }),
                    ),
                  );
                },
                onSleep: () =>
                  Effect.runPromise(
                    Deferred.succeed(controlSlept, undefined).pipe(
                      Effect.asVoid,
                    ),
                  ),
              }),
            },
            endpoint: process.env.RIVET_ENDPOINT,
            startEngine: false,
            httpHost: "127.0.0.1",
            httpPort: 21131,
            shutdown: { disableSignalHandlers: true, gracePeriodMs: 5000 },
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => registry.shutdown()),
          );
          yield* Effect.addFinalizer(() =>
            Effect.forEach(
              actorIds,
              (id) =>
                HttpClient.execute(
                  HttpClientRequest.delete(
                    `${connection.endpoint}/actors/${id}?namespace=${encodeURIComponent(connection.namespace)}`,
                  ).pipe(
                    HttpClientRequest.setHeader(
                      "Authorization",
                      `Bearer ${connection.token}`,
                    ),
                  ),
                ).pipe(
                  Effect.tap((response) =>
                    Effect.sync(() => expect(response.status).toBe(200)),
                  ),
                  Effect.timeout("10 seconds"),
                ),
              { discard: true },
            ).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
          );
          yield* Effect.promise(() => registry.startAndWait());
          const exchange = (socket: globalThis.WebSocket, message: string) =>
            Effect.callback<string>((resume) => {
              const received = (event: MessageEvent) =>
                resume(Effect.succeed(String(event.data)));
              const failed = () =>
                resume(
                  Effect.die(
                    new Error("Native idle socket closed before response"),
                  ),
                );
              const send = () => socket.send(message);
              socket.addEventListener("message", received, { once: true });
              socket.addEventListener("close", failed, { once: true });
              socket.addEventListener("error", failed, { once: true });
              if (socket.readyState === globalThis.WebSocket.OPEN) send();
              else socket.addEventListener("open", send, { once: true });
              return Effect.sync(() => {
                socket.removeEventListener("message", received);
                socket.removeEventListener("close", failed);
                socket.removeEventListener("error", failed);
                socket.removeEventListener("open", send);
              });
            }).pipe(Effect.timeout("10 seconds"));
          const identity = (text: string) =>
            Effect.sync(() => {
              const decoded = JSON.parse(text);
              return Schema.decodeUnknownSync(
                Schema.Struct({
                  actorId: Schema.String,
                  boot: Schema.Number,
                  connection: Schema.optional(Schema.String),
                }),
              )(decoded.exit?.value ?? decoded);
            });
          const results = yield* Effect.forEach(
            [
              { name: "IdleControl", slept: controlSlept, message: "identity" },
              {
                name: "IdleProof",
                slept: providerSlept,
                message: JSON.stringify({
                  _tag: "Request",
                  id: "1",
                  tag: "identity",
                  payload: null,
                  headers: [],
                }),
              },
            ],
            ({ name, slept, message }) =>
              Effect.gen(function* () {
                const socket = yield* Effect.acquireRelease(
                  Effect.sync(
                    () =>
                      new globalThis.WebSocket(
                        rivetRpcWebSocketUrl(connection, name, "idle-proof"),
                        ["rivet", "rivet_encoding.bare"],
                      ),
                  ),
                  (socket) => Effect.sync(() => socket.close()),
                );
                const first = yield* exchange(socket, message);
                const initial = yield* identity(first);
                expect(initial.boot).toBe(1);
                yield* Effect.logInfo("idle initial response", {
                  name,
                  first,
                  activity: { ...activity },
                });
                const idle = yield* Deferred.await(slept).pipe(
                  Effect.timeout("10 seconds"),
                  Effect.exit,
                );
                yield* Effect.logInfo("idle observation", {
                  name,
                  idle,
                  activity: { ...activity },
                });
                if (idle._tag === "Failure") {
                  expect(activity.keepAwake).toBe(0);
                  expect(activity.waitUntil).toBe(0);
                  if (name === "IdleProof") expect(activity.messages).toBe(1);
                  yield* Effect.sync(() => socket.close());
                  const afterClose = yield* Deferred.await(slept).pipe(
                    Effect.timeout("5 seconds"),
                    Effect.exit,
                  );
                  yield* Effect.logInfo("idle after closing native socket", {
                    name,
                    afterClose,
                    activity: { ...activity },
                  });
                  expect(afterClose._tag).toBe("Success");
                  return false;
                }
                expect(socket.readyState).toBe(globalThis.WebSocket.OPEN);
                const second = yield* exchange(
                  socket,
                  message.replace('"id":"1"', '"id":"2"'),
                );
                yield* Effect.logInfo("idle restored response", {
                  name,
                  second,
                });
                const restored = yield* identity(second);
                expect(restored.actorId).toBe(initial.actorId);
                expect(restored.boot).toBeGreaterThan(initial.boot);
                expect(restored.connection).toBe(initial.connection);
                return true;
              }).pipe(Effect.scoped),
          );
          expect(results).toEqual([true, true]);
        }).pipe(Effect.scoped),
      { timeout: 60_000, exclusive: true },
    );
    it.live(
      `keeps connections through ${process.env.ALCHEMY_TEST_RIVET_IDLE ? "automatic idle" : "explicit native sleep"}, streams before completion, and wakes callbacks`,
      () =>
        Effect.gen(function* () {
          let slept = yield* Deferred.make<void>();
          let archivedWhileDormant = yield* Deferred.make<void>();
          const finalizerEnded = yield* Deferred.make<void>();
          let retirements = 0;
          const actorIds = new Set<string>();
          const clientSockets: globalThis.WebSocket[] = [];
          const constructor: DurableObjectExport["constructor"] = Effect.gen(
            function* () {
              const state = yield* DurableObjectState;
              yield* Effect.sync(() => actorIds.add(state.actorId));
              return Effect.gen(function* () {
                const boot =
                  ((yield* state.storage.get<number>("boots")) ?? 0) + 1;
                yield* state.storage.put("boots", boot);
                yield* Effect.logInfo("native activation", {
                  actorId: state.actorId,
                  boot,
                });
                const archive = yield* makeCallback("archive", () =>
                  state.storage
                    .put("archived", true)
                    .pipe(
                      Effect.andThen(
                        Deferred.succeed(archivedWhileDormant, undefined),
                      ),
                    ),
                );
                let transport:
                  | Effect.Success<typeof RivetRpcWebSocket.make>
                  | undefined;
                const handlers = yield* makeHandlers(
                  NativeRpcs,
                  NativeRpcs.toLayer({
                    identity: () =>
                      Effect.succeed({ actorId: state.actorId, boot }),
                    hold: () =>
                      Effect.addFinalizer(() =>
                        Effect.sleep("2500 millis").pipe(
                          Effect.andThen(
                            Deferred.succeed(finalizerEnded, undefined),
                          ),
                        ),
                      ).pipe(Effect.as(boot)),
                    numbers: () =>
                      Stream.unwrap(
                        state.storage
                          .put("finalized", false)
                          .pipe(
                            Effect.as(
                              Stream.make(1).pipe(
                                Stream.concat(
                                  Stream.fromEffect(
                                    Effect.sleep("30 seconds").pipe(
                                      Effect.as(2),
                                    ),
                                  ),
                                ),
                                Stream.ensuring(
                                  state.storage.put("finalized", true),
                                ),
                              ),
                            ),
                          ),
                      ),
                  }),
                  {
                    http: false,
                    transport: RivetRpcWebSocket.make.pipe(
                      Effect.tap((value) =>
                        Effect.sync(() => {
                          transport = value;
                        }),
                      ),
                    ),
                  },
                );
                const { fetch: _, ...events } = handlers;
                return {
                  ...events,
                  webSocketOpen: (
                    socket: Parameters<
                      NonNullable<typeof transport>["accept"]
                    >[0],
                  ) =>
                    Effect.gen(function* () {
                      const attachment = yield* Effect.sync(() =>
                        socket.deserializeAttachment(),
                      );
                      if (attachment === null)
                        yield* socket.setAttachment(Session, {
                          version: 1,
                          user: "sam",
                        });
                      else
                        expect(yield* socket.getAttachment(Session)).toEqual({
                          version: 1,
                          user: "sam",
                        });
                      return yield* transport!.accept(socket);
                    }),
                  sleep: () =>
                    NativeContext.pipe(
                      Effect.flatMap((native) =>
                        Effect.sync(() => native.sleep()),
                      ),
                    ),
                  schedule: () =>
                    state.storage.put("archived", false).pipe(
                      Effect.andThen(
                        archive.schedule("one", {
                          after: "2 seconds",
                          payload: null,
                        }),
                      ),
                    ),
                  losePreciseWake: () =>
                    Effect.gen(function* () {
                      const native = yield* NativeContext;
                      const wake = native.state.callbackWake;
                      if (wake)
                        yield* Effect.promise(() =>
                          native.schedule.cancel(wake.id),
                        );
                      native.state.callbackWake = undefined;
                      yield* Effect.promise(() =>
                        native.saveState({ immediate: true }),
                      );
                    }),
                  migrate: () =>
                    Effect.gen(function* () {
                      const failed = yield* applyRivetSqlMigrations(
                        migrationSnapshot,
                      ).pipe(
                        Effect.as(false),
                        Effect.catchTag("MigrationError", () =>
                          Effect.succeed(true),
                        ),
                      );
                      return {
                        failed,
                        rows: yield* state.storage.sql.exec<{ id: number }>(
                          "SELECT id FROM migration_probe ORDER BY id",
                        ),
                      };
                    }),
                  status: () =>
                    Effect.all({
                      archived: state.storage.get("archived"),
                      finalized: state.storage.get("finalized"),
                      pendingCallbacks: NativeContext.pipe(
                        Effect.map(
                          (native) =>
                            Object.keys(native.state.callbacks ?? {}).length,
                        ),
                      ),
                    }),
                };
              });
            },
          );
          const definition = makeRivetActor(
            ((config) =>
              actor({
                ...config,
                options: { ...config.options, sleepTimeout: 1000 },
                onSleep: (native: Parameters<typeof config.onSleep>[0]) =>
                  Effect.runPromise(
                    Effect.promise(() => config.onSleep(native)).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          retirements++;
                        }),
                      ),
                      Effect.andThen(Deferred.succeed(slept, undefined)),
                      Effect.asVoid,
                    ),
                  ),
              } as any)) as RivetActorFactory,
            {
              methods: [],
              db: db(),
              build: () =>
                Effect.runPromise(
                  Effect.succeed({
                    context: Context.make(WorkerEnvironment, {}).pipe(
                      Context.add(Telemetry, Layer.empty),
                      Context.add(RuntimeContext, {
                        Type: "Rivet.Worker",
                        id: "native",
                        env: {},
                        get: () => Effect.succeed(undefined),
                        set: (key) => Effect.succeed(key),
                      }),
                    ),
                    export: {
                      kind: "durableObject",
                      provider: "Rivet",
                      constructor,
                      services: Context.empty(),
                    },
                    shape: () => ({}),
                    telemetry: () => undefined,
                  } satisfies WorkerBuild<DurableObjectExport>),
                ),
            },
          );
          const registry = setup({
            use: {
              NativeProof: definition as ReturnType<typeof actor>,
              NativeControl: actor({
                state: {},
                actions: {
                  __alchemyCall: (native) =>
                    Effect.runPromise(
                      Effect.sync(() => {
                        actorIds.add(native.actorId);
                        return true;
                      }),
                    ),
                },
              }),
            },
            ...(process.env.RIVET_ENDPOINT
              ? { endpoint: process.env.RIVET_ENDPOINT, startEngine: false }
              : {
                  startEngine: true,
                  engineHost: "127.0.0.1",
                  enginePort: 21130,
                }),
            httpHost: "127.0.0.1",
            httpPort: 21131,
            shutdown: { disableSignalHandlers: true, gracePeriodMs: 5000 },
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => registry.shutdown()),
          );
          yield* Effect.addFinalizer(() =>
            Effect.forEach(
              actorIds,
              (id) =>
                HttpClient.execute(
                  HttpClientRequest.delete(
                    `${connection.endpoint}/actors/${id}?namespace=${encodeURIComponent(connection.namespace)}`,
                  ).pipe(
                    HttpClientRequest.setHeader(
                      "Authorization",
                      `Bearer ${connection.token}`,
                    ),
                  ),
                ).pipe(
                  Effect.flatMap((response) =>
                    (response.status >= 200 && response.status < 300) ||
                    response.status === 404
                      ? Effect.void
                      : Effect.die(
                          new Error(
                            `Native actor cleanup returned ${response.status}`,
                          ),
                        ),
                  ),
                  Effect.timeout("10 seconds"),
                ),
              { discard: true },
            ).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
          );
          yield* Effect.promise(() => registry.startAndWait());
          const control = makeRivetActorClient<{
            ping(): Effect.Effect<boolean, unknown>;
          }>(connection, "NativeControl").getByName("native-control");
          expect(yield* control.ping().pipe(Effect.timeout("10 seconds"))).toBe(
            true,
          );
          yield* Effect.logInfo("native control actor ready");
          const actions = makeRivetActorClient<NativeActions>(
            connection,
            "NativeProof",
          ).getByName("native-proof");
          yield* actions.status().pipe(Effect.timeout("10 seconds"));
          yield* Effect.logInfo("native action ready");
          expect(
            yield* actions.migrate().pipe(Effect.timeout("10 seconds")),
          ).toEqual({ failed: true, rows: [{ id: 1 }] });
          expect(
            yield* actions.migrate().pipe(Effect.timeout("10 seconds")),
          ).toEqual({ failed: true, rows: [{ id: 1 }] });
          const makeClientLayer = () =>
            RpcWebSocketClient.layer(
              NativeClient,
              NativeRpcs,
              rivetRpcWebSocketUrl(connection, "NativeProof", "native-proof"),
              { socket: { protocols: ["rivet", "rivet_encoding.bare"] } },
            ).pipe(
              Layer.provide(
                Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
                  if (
                    protocols !== undefined &&
                    typeof protocols !== "string" &&
                    !Array.isArray(protocols)
                  )
                    throw new TypeError("Unsupported native test protocols");
                  const socket = new globalThis.WebSocket(url, protocols);
                  clientSockets.push(socket);
                  return socket;
                }),
              ),
            );
          yield* Effect.gen(function* () {
            const client = yield* NativeClient;
            const first = yield* client
              .identity()
              .pipe(Effect.timeout("10 seconds"));
            yield* Effect.logInfo("native RPC connected", first);
            const clientB = Context.get(
              yield* Layer.build(makeClientLayer()),
              NativeClient,
            );
            expect(
              (yield* clientB.identity().pipe(Effect.timeout("10 seconds")))
                .actorId,
            ).toBe(first.actorId);
            expect(clientSockets.length).toBe(2);
            const beforeFinalizer = retirements;
            expect(
              yield* client.hold().pipe(Effect.timeout("10 seconds")),
            ).toBe(first.boot);
            yield* Deferred.await(finalizerEnded).pipe(
              Effect.timeout("10 seconds"),
            );
            expect(retirements).toBe(beforeFinalizer);
            const chunks = yield* client
              .numbers()
              .pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.timeout("5 seconds"),
              );
            expect([...chunks]).toEqual([1]);
            const finalized = yield* actions.status().pipe(
              Effect.repeat({
                until: (value) => value.finalized === true,
                schedule: Schedule.spaced("250 millis"),
                times: 10,
              }),
            );
            expect(finalized.finalized).toBe(true);
            yield* Effect.logInfo("native stream finalized");
            yield* actions.schedule().pipe(Effect.timeout("10 seconds"));
            yield* Effect.logInfo("native callback scheduled");
            if (!process.env.ALCHEMY_TEST_RIVET_IDLE)
              yield* actions.sleep().pipe(Effect.timeout("10 seconds"));
            yield* Deferred.await(slept).pipe(Effect.timeout("10 seconds"));
            yield* Effect.logInfo("native sleep observed");
            yield* Deferred.await(archivedWhileDormant).pipe(
              Effect.timeout("10 seconds"),
            );
            yield* Effect.logInfo(
              "native callback woke dormant actor without a request",
            );
            expect(
              clientSockets.every(
                (socket) => socket.readyState === globalThis.WebSocket.OPEN,
              ),
            ).toBe(true);
            const second = yield* client
              .identity()
              .pipe(Effect.timeout("10 seconds"));
            yield* Effect.logInfo("native RPC reawakened", second);
            expect(second.actorId).toBe(first.actorId);
            expect(second.boot).toBeGreaterThan(first.boot);
            const clientC = Context.get(
              yield* Layer.build(makeClientLayer()),
              NativeClient,
            );
            expect(
              (yield* clientC.identity().pipe(Effect.timeout("10 seconds")))
                .actorId,
            ).toBe(first.actorId);
            expect(
              (yield* clientB.identity().pipe(Effect.timeout("10 seconds")))
                .actorId,
            ).toBe(first.actorId);
            expect(clientSockets.length).toBe(3);
            expect(
              clientSockets.every(
                (socket) => socket.readyState === globalThis.WebSocket.OPEN,
              ),
            ).toBe(true);
            const result = yield* actions.status().pipe(
              Effect.repeat({
                until: (value) => value.archived === true,
                schedule: Schedule.spaced("500 millis"),
                times: 10,
              }),
            );
            expect(result.archived).toBe(true);
            expect(result.finalized).toBe(true);
          }).pipe(Effect.provide(makeClientLayer()), Effect.scoped);
          slept = yield* Deferred.make<void>();
          archivedWhileDormant = yield* Deferred.make<void>();
          yield* actions.schedule().pipe(Effect.timeout("10 seconds"));
          yield* actions.losePreciseWake().pipe(Effect.timeout("10 seconds"));
          if (!process.env.ALCHEMY_TEST_RIVET_IDLE)
            yield* actions.sleep().pipe(Effect.timeout("10 seconds"));
          yield* Deferred.await(slept).pipe(Effect.timeout("10 seconds"));
          slept = yield* Deferred.make<void>();
          yield* Deferred.await(archivedWhileDormant).pipe(
            Effect.timeout("40 seconds"),
          );
          yield* Effect.logInfo(
            "native watchdog recovered a durable job without its one-shot wake",
          );
          const acknowledged = yield* actions.status().pipe(
            Effect.repeat({
              until: (value) => value.pendingCallbacks === 0,
              schedule: Schedule.spaced("100 millis"),
              times: 10,
            }),
          );
          expect(acknowledged.pendingCallbacks).toBe(0);
          if (process.env.ALCHEMY_TEST_RIVET_IDLE)
            yield* Deferred.await(slept).pipe(Effect.timeout("10 seconds"));
        }).pipe(Effect.scoped),
      { timeout: 90_000, exclusive: true },
    );
  },
);
