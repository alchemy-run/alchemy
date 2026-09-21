import {
  CALL_ACTION,
  makeRivetActor,
  type RivetActorFactory,
} from "@/Rivet/DurableObjectBridge.ts";
import {
  ALARM_ACTION,
  DurableObjectState,
  fromRivetActor,
  NativeContext,
  type RivetActorContext,
} from "@/Rivet/DurableObjectState.ts";
import { fromWebSocket, type RawWebSocket } from "@/Rivet/WebSocket.ts";
import type { DurableObjectExport } from "@/Workers/DurableObject.ts";
import { WorkerEnvironment, type WorkerBuild } from "@/Workers/Worker.ts";
import { Telemetry } from "@/TelemetryRuntime.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Schema from "effect/Schema";
import { makeRivetCallbackStore } from "@/Rivet/AlarmCallback.ts";
import { allocateClientId } from "@/Rivet/RpcWebSocket.ts";
import { rivetRpcWebSocketUrl } from "@/Rivet/Gateway.ts";
import {
  readRpcMetadata,
  writeRpcMetadata,
} from "@/Workers/WebSocketAttachment.ts";
import { connectionAttachment } from "@/Rivet/WebSocket.ts";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";

type ActorDefinition = Parameters<RivetActorFactory>[0];

const makeNative = (actorId: string) => {
  const pending: Promise<unknown>[] = [];
  const scheduled: Array<{
    id: string;
    time: number;
    action: string;
    args: unknown[];
  }> = [];
  const cancelled: string[] = [];
  const native: RivetActorContext = {
    actorId,
    key: [actorId, "partition"],
    name: "Counter",
    state: { kv: {} },
    conn: { id: `connection-${actorId}`, state: { version: 1, tags: [] } },
    abortSignal: new AbortController().signal,
    saveState: () => Effect.runPromise(Effect.void),
    keepAwake: (promise) => promise,
    sleep: () => {},
    destroy: () => {},
    cron: {
      get: () => Effect.runPromise(Effect.succeed(undefined)),
      every: () => Effect.runPromise(Effect.void),
      set: () => Effect.runPromise(Effect.void),
      delete: () => Effect.runPromise(Effect.succeed(true)),
      list: () => Effect.runPromise(Effect.succeed([])),
      history: () => Effect.runPromise(Effect.succeed([])),
    },
    db: {
      execute: () => Effect.runPromise(Effect.succeed([])),
      transaction: () => Effect.runPromise(Effect.die("not used")),
      close: () => Effect.runPromise(Effect.void),
    },
    schedule: {
      at: (time, action, ...args) => {
        const id = `event-${scheduled.length}`;
        scheduled.push({ id, time, action, args });
        return Effect.runPromise(Effect.succeed(id));
      },
      after: () => Effect.runPromise(Effect.die("not used")),
      cancel: (id) => {
        cancelled.push(id);
        return Effect.runPromise(Effect.succeed(true));
      },
      get: () => Effect.runPromise(Effect.succeed(undefined)),
      list: () => Effect.runPromise(Effect.succeed([])),
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  return { native, pending, scheduled, cancelled };
};

const gateAlarmScheduling = (native: RivetActorContext) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void, Error>();
    const scheduleAt = native.schedule.at;
    native.schedule.at = (time, action, ...args) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          return yield* Effect.promise(() => scheduleAt(time, action, ...args));
        }),
      );
    return { started, release };
  });

const makeBuild = (constructor: DurableObjectExport["constructor"]) => () =>
  Effect.runPromise(
    Effect.succeed({
      context: Context.make(WorkerEnvironment, {}).pipe(
        Context.add(Telemetry, Layer.empty),
        Context.add(RuntimeContext, {
          Type: "Rivet.Worker",
          id: "unit",
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
  );

const register = (
  constructor: DurableObjectExport["constructor"],
  methods: string[],
) => {
  let definition: ActorDefinition | undefined;
  makeRivetActor(
    (config) => {
      definition = config;
      return config;
    },
    {
      build: makeBuild(constructor),
      methods,
    },
  );
  if (definition === undefined) throw new Error("Actor was not registered");
  return definition;
};

const action = (
  definition: ActorDefinition,
  method: string,
  native: RivetActorContext,
  ...args: unknown[]
) =>
  Effect.promise(
    () =>
      definition.actions[method](native, ...args) ??
      Effect.runPromise(Effect.void),
  );

const drain = (pending: Promise<unknown>[]) =>
  Effect.forEach(pending, (promise) => Effect.promise(() => promise), {
    discard: true,
  });

const makeSocket = () => {
  const listeners = new Map<
    string,
    Parameters<RawWebSocket["addEventListener"]>[1]
  >();
  const sent: unknown[] = [];
  const closed: unknown[] = [];
  const socket: RawWebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    readyState: 1,
    binaryType: "arraybuffer",
    bufferedAmount: 0,
    extensions: "",
    protocol: "",
    url: "ws://unit-test.invalid",
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => {
      closed.push([code, reason]);
    },
    addEventListener: (type, listener) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type) => {
      listeners.delete(type);
    },
    dispatchEvent: () => false,
  };
  return { socket, listeners, sent, closed };
};

describe("Rivet provider-owned runtime", () => {
  it.effect(
    "routes raw WebSockets only to the private gateway without management credentials",
    () =>
      Effect.sync(() => {
        const url = new URL(
          rivetRpcWebSocketUrl(
            {
              endpoint: "https://default:management-token@engine.internal",
              namespace: "private",
              pool: "actors",
            },
            "Room",
            "team/room",
          ),
        );
        expect(url.protocol).toBe("wss:");
        expect(url.host).toBe("engine.internal");
        expect(url.pathname).toBe("/gateway/Room/websocket/");
        expect(url.username).toBe("");
        expect(url.password).toBe("");
        expect(url.searchParams.get("rvt-key")).toBe("team/room");
        expect(url.searchParams.get("rvt-namespace")).toBe("private");
        expect(url.searchParams.get("rvt-runner")).toBe("actors");
      }),
    { timeout: 5000 },
  );
  it.effect(
    "persists fresh RPC IDs independently of lazily restored sockets",
    () =>
      Effect.gen(function* () {
        const { native } = makeNative("rpc-ids");
        const persisted: number[] = [];
        native.saveState = () =>
          Effect.runPromise(
            Effect.sync(() => {
              persisted.push(native.state.rpcNextClientId!);
            }),
          );
        const ids = yield* Effect.all([allocateClientId, allocateClientId], {
          concurrency: 2,
        }).pipe(Effect.provideService(NativeContext, native));
        expect(ids).toEqual([0, 1]);
        expect(persisted).toHaveLength(2);
        const fresh = { ...native, state: { ...native.state } };
        expect(
          yield* allocateClientId.pipe(
            Effect.provideService(NativeContext, fresh),
          ),
        ).toBe(2);
      }),
    { timeout: 5000 },
  );
  it.effect(
    "preserves reserved RPC metadata and rejects non-JSON attachments",
    () =>
      Effect.gen(function* () {
        const { native } = makeNative("attachments");
        const { socket } = makeSocket();
        const wrapped = fromWebSocket(socket, native.conn!);
        const storage = connectionAttachment(native.conn!);
        storage.write(writeRpcMetadata(null, { version: 1, pending: true }));
        yield* wrapped.setAttachment(Schema.Struct({ value: Schema.String }), {
          value: "application",
        });
        expect(readRpcMetadata(storage.read())).toEqual({
          version: 1,
          pending: true,
        });
        expect(
          yield* wrapped.getAttachment(Schema.Struct({ value: Schema.String })),
        ).toEqual({ value: "application" });
        const date = yield* Effect.sync(() => new Date());
        const failed = yield* wrapped
          .setAttachment(Schema.Unknown, date)
          .pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(readRpcMetadata(storage.read())).toEqual({
          version: 1,
          pending: true,
        });
      }),
    { timeout: 5000 },
  );

  it.effect(
    "arms recurring recovery before publishing callbacks and persists removal before disarming",
    () =>
      Effect.gen(function* () {
        const { native } = makeNative("callbacks");
        const order: string[] = [];
        native.cron.every = () =>
          Effect.runPromise(
            Effect.sync(() => {
              order.push("arm");
            }),
          );
        native.cron.delete = () =>
          Effect.runPromise(
            Effect.sync(() => {
              order.push("disarm");
              return true;
            }),
          );
        native.saveState = () =>
          Effect.runPromise(
            Effect.sync(() => {
              order.push(
                Object.keys(native.state.callbacks ?? {}).length
                  ? "save-job"
                  : "save-empty",
              );
            }),
          );
        const store = makeRivetCallbackStore();
        const job = {
          callback: "archive",
          id: "same",
          version: "one",
          runAt: 100,
          payload: "null",
        };
        yield* Effect.gen(function* () {
          yield* store.put(job);
          expect(order[0]).toBe("arm");
          expect(order[1]).toBe("save-job");
          expect(yield* store.claim(job, 200)).toBe(true);
          expect(yield* store.claim(job, 200)).toBe(false);
          yield* store.put({ ...job, version: "two", runAt: 300 });
          yield* store.acknowledge(job);
          expect(yield* store.due(300, 100)).toHaveLength(1);
          order.length = 0;
          yield* store.remove(job.callback, job.id);
          expect(order.indexOf("save-empty")).toBeLessThan(
            order.indexOf("disarm"),
          );
        }).pipe(Effect.provideService(NativeContext, native));
      }),
    { timeout: 5000 },
  );

  it.effect(
    "closes the activation scope on sleep without closing retained sockets",
    () =>
      Effect.gen(function* () {
        let finalizers = 0;
        const definition = register(
          Effect.succeed(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalizers++;
                }),
              );
              return {};
            }),
          ),
          [],
        );
        const { native } = makeNative("retirement");
        const vars = yield* Effect.promise(() => definition.createVars(native));
        const { socket, closed } = makeSocket();
        yield* Effect.promise(() =>
          Promise.resolve(definition.onWebSocket({ ...native, vars }, socket)),
        );
        yield* Effect.promise(() => definition.onSleep({ ...native, vars }));
        yield* Effect.promise(() => definition.onDestroy({ ...native, vars }));
        expect(finalizers).toBe(1);
        expect(closed).toEqual([]);
      }),
    { timeout: 5000 },
  );
  it.effect(
    "exposes only native-backed state and storage operations",
    () =>
      Effect.gen(function* () {
        const { native } = makeNative("native-id");
        const state = fromRivetActor(native, new Map());
        expect(DurableObjectState.key).toBe("Rivet.DurableObjectState");
        expect(state.actorId).toBe("native-id");
        expect(state.key).toEqual(["native-id", "partition"]);
        for (const key of [
          "id",
          "abort",
          "blockConcurrencyWhile",
          "acceptWebSocket",
          "setWebSocketAutoResponse",
          "container",
        ]) {
          expect(key in state).toBe(false);
        }
        for (const key of [
          "sync",
          "transaction",
          "kv",
          "getCurrentBookmark",
          "blockConcurrencyWhile",
        ]) {
          expect(key in state.storage).toBe(false);
        }
        yield* Effect.gen(function* () {
          expect(yield* state.raw).toBe(native);
          yield* state.storage.put({ first: 1, second: 2 });
          expect(yield* state.storage.get<number>("first")).toBe(1);
          expect(
            yield* state.storage.get<number>(["second", "missing"]),
          ).toEqual(new Map([["second", 2]]));
          expect(
            yield* state.storage.list<number>({ reverse: true, limit: 1 }),
          ).toEqual(new Map([["second", 2]]));
          expect(yield* state.storage.delete(["first", "missing"])).toBe(1);
          expect(yield* state.storage.delete("second")).toBe(true);
        }).pipe(Effect.provideService(NativeContext, native));
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "returns native SQL rows without fabricated cursor metadata",
    () =>
      Effect.gen(function* () {
        const { native } = makeNative("sql");
        const queries: unknown[] = [];
        const rows = [{ value: 42 }];
        native.db.execute = <Row extends Record<string, unknown>>(
          query: string,
          ...bindings: unknown[]
        ) => {
          queries.push([query, bindings]);
          return Effect.runPromise(Effect.succeed(rows as unknown as Row[]));
        };
        const state = fromRivetActor(native, new Map());
        const result = yield* state.storage.sql
          .exec<{ value: number }>("SELECT ? AS value", 42)
          .pipe(Effect.provideService(NativeContext, native));
        expect(result).toBe(rows);
        expect(result).toEqual([{ value: 42 }]);
        expect("rowsWritten" in result).toBe(false);
        expect("columnNames" in result).toBe(false);
        expect(queries).toEqual([["SELECT ? AS value", [42]]]);
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "cancels replaced alarms and ignores stale native deliveries",
    () =>
      Effect.gen(function* () {
        let fired = 0;
        const definition = register(
          Effect.succeed(
            Effect.succeed({
              alarm: () =>
                Effect.sync(() => {
                  fired++;
                }),
            }),
          ),
          [],
        );
        const { native, pending, scheduled, cancelled } = makeNative("alarm");
        const vars = yield* Effect.promise(() => definition.createVars(native));
        const call = { ...native, vars };
        const state = fromRivetActor(native, new Map());
        yield* state.storage
          .setAlarm(100)
          .pipe(Effect.provideService(NativeContext, call));
        yield* state.storage
          .setAlarm(200)
          .pipe(Effect.provideService(NativeContext, call));
        expect(scheduled.map(({ action }) => action)).toEqual([
          ALARM_ACTION,
          ALARM_ACTION,
        ]);
        expect(cancelled).toEqual(["event-0"]);
        yield* action(definition, ALARM_ACTION, call, 1);
        expect(fired).toBe(0);
        yield* action(definition, ALARM_ACTION, call, 2);
        expect(fired).toBe(1);
        expect(
          yield* state.storage
            .getAlarm()
            .pipe(Effect.provideService(NativeContext, call)),
        ).toBeNull();
        yield* state.storage
          .setAlarm(300)
          .pipe(Effect.provideService(NativeContext, call));
        yield* state.storage
          .deleteAlarm()
          .pipe(Effect.provideService(NativeContext, call));
        expect(cancelled).toEqual(["event-0", "event-2"]);
        yield* action(definition, ALARM_ACTION, call, 3);
        expect(fired).toBe(1);
        yield* drain(pending);
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "preserves a live alarm when a concurrent replacement fails",
    () =>
      Effect.gen(function* () {
        const first = makeNative("first");
        const second = makeNative("second");
        const secondCall = { ...second.native, state: first.native.state };
        const state = fromRivetActor(first.native, new Map());
        const firstGate = yield* gateAlarmScheduling(first.native);
        const secondGate = yield* gateAlarmScheduling(secondCall);
        const firstSet = yield* state.storage
          .setAlarm(100)
          .pipe(
            Effect.provideService(NativeContext, first.native),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(firstGate.started);
        const secondSet = yield* state.storage
          .setAlarm(200)
          .pipe(
            Effect.provideService(NativeContext, secondCall),
            Effect.exit,
            Effect.forkChild({ startImmediately: true }),
          );
        const secondStartedEarly = yield* Deferred.isDone(secondGate.started);
        yield* Deferred.succeed(firstGate.release, undefined);
        yield* Fiber.join(firstSet);
        yield* Deferred.await(secondGate.started);
        yield* Deferred.fail(secondGate.release, new Error("schedule failed"));
        const exit = yield* Fiber.join(secondSet);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("schedule failed");
        }
        expect(secondStartedEarly).toBe(false);
        expect(
          yield* state.storage
            .getAlarm()
            .pipe(Effect.provideService(NativeContext, secondCall)),
        ).toBe(100);
        expect(first.native.state.alarm).toEqual({
          time: 100,
          generation: 1,
          scheduleId: "event-0",
        });
        expect(first.scheduled).toEqual([
          { id: "event-0", time: 100, action: ALARM_ACTION, args: [1] },
        ]);
        expect(second.scheduled).toEqual([]);
        expect(first.cancelled).toEqual([]);
        expect(second.cancelled).toEqual([]);
        yield* state.storage
          .deleteAlarm()
          .pipe(Effect.provideService(NativeContext, secondCall));
        expect(second.cancelled).toEqual(["event-0"]);
        expect(first.cancelled).toEqual([]);
        expect(first.native.state.alarm).toBeUndefined();
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "serializes alarm deletion with pending scheduling and native cancellation",
    () =>
      Effect.gen(function* () {
        const first = makeNative("scheduler");
        const deletion = makeNative("deleter");
        const deleteCall = { ...deletion.native, state: first.native.state };
        const state = fromRivetActor(first.native, new Map());
        const gate = yield* gateAlarmScheduling(first.native);
        const cancelStarted = yield* Deferred.make<string>();
        const releaseCancel = yield* Deferred.make<void>();
        const cancel = deleteCall.schedule.cancel;
        deleteCall.schedule.cancel = (id) =>
          Effect.runPromise(
            Effect.gen(function* () {
              yield* Deferred.succeed(cancelStarted, id);
              yield* Deferred.await(releaseCancel);
              return yield* Effect.promise(() => cancel(id));
            }),
          );
        const firstSet = yield* state.storage
          .setAlarm(100)
          .pipe(
            Effect.provideService(NativeContext, first.native),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(gate.started);
        const deleted = yield* state.storage
          .deleteAlarm()
          .pipe(
            Effect.provideService(NativeContext, deleteCall),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(firstSet);
        const cancelledId = yield* Deferred.await(cancelStarted);
        const replacement = yield* state.storage
          .setAlarm(300)
          .pipe(
            Effect.provideService(NativeContext, first.native),
            Effect.forkChild({ startImmediately: true }),
          );
        const schedulesBeforeCancellation = first.scheduled.length;
        yield* Deferred.succeed(releaseCancel, undefined);
        yield* Fiber.join(deleted);
        yield* Fiber.join(replacement);
        expect(cancelledId).toBe("event-0");
        expect(schedulesBeforeCancellation).toBe(1);
        expect(first.scheduled.map(({ time }) => time)).toEqual([100, 300]);
        expect(first.cancelled).toEqual([]);
        expect(deletion.cancelled).toEqual(["event-0"]);
        expect(first.native.state.alarm).toEqual({
          time: 300,
          generation: 3,
          scheduleId: "event-1",
        });
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "settles interrupted native scheduling while allowing queued alarm mutations to be interrupted",
    () =>
      Effect.gen(function* () {
        const first = makeNative("scheduler");
        const queued = makeNative("queued");
        const deletion = makeNative("deleter");
        const queuedCall = { ...queued.native, state: first.native.state };
        const deleteCall = { ...deletion.native, state: first.native.state };
        const state = fromRivetActor(first.native, new Map());
        const gate = yield* gateAlarmScheduling(first.native);
        const firstSet = yield* state.storage
          .setAlarm(100)
          .pipe(
            Effect.provideService(NativeContext, first.native),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.await(gate.started);
        const queuedSet = yield* state.storage
          .setAlarm(200)
          .pipe(
            Effect.provideService(NativeContext, queuedCall),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Fiber.interrupt(queuedSet);
        const interrupted = yield* Fiber.interrupt(firstSet).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const deleted = yield* state.storage
          .deleteAlarm()
          .pipe(
            Effect.provideService(NativeContext, deleteCall),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(interrupted);
        yield* Fiber.join(deleted);
        const exit = yield* Fiber.await(firstSet);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(queued.scheduled).toEqual([]);
        expect(first.scheduled).toEqual([
          { id: "event-0", time: 100, action: ALARM_ACTION, args: [1] },
        ]);
        expect(first.cancelled).toEqual([]);
        expect(deletion.cancelled).toEqual(["event-0"]);
        expect(
          yield* state.storage
            .getAlarm()
            .pipe(Effect.provideService(NativeContext, deleteCall)),
        ).toBeNull();
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "keeps concurrent actions, deferred work and finalizers on their originating contexts",
    () =>
      Effect.gen(function* () {
        let constructions = 0;
        const deferred: string[] = [];
        const finalized: string[] = [];
        const definition = register(
          Effect.gen(function* () {
            const state = yield* DurableObjectState;
            const services = yield* Effect.context<DurableObjectState>();
            for (const key of [
              "Cloudflare.DurableObjectState",
              "Celld.DurableObjectState",
            ]) {
              expect(
                Context.getOption(
                  services,
                  Context.Service<never, unknown>(key),
                )._tag,
              ).toBe("None");
            }
            return Effect.sync(() => {
              constructions++;
              return {
                alarm: () => Effect.void,
                observe: (
                  started: Deferred.Deferred<void>,
                  release: Deferred.Deferred<void>,
                ) =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      state.raw.pipe(
                        Effect.map((native) => {
                          finalized.push(native.actorId);
                        }),
                      ),
                    );
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    const native = yield* state.raw;
                    yield* state.storage.put("owner", native.actorId);
                    yield* state.waitUntil(
                      state.raw.pipe(
                        Effect.map((owner) => {
                          deferred.push(owner.actorId);
                        }),
                      ),
                    );
                    return native.actorId;
                  }),
              };
            });
          }),
          ["observe"],
        );
        const activation = makeNative("activation");
        const vars = yield* Effect.promise(() =>
          definition.createVars(activation.native),
        );
        const first = makeNative("first");
        const second = makeNative("second");
        const startedFirst = yield* Deferred.make<void>();
        const startedSecond = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const releaseSecond = yield* Deferred.make<void>();
        const firstCall = yield* action(
          definition,
          "observe",
          { ...first.native, vars },
          startedFirst,
          releaseFirst,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(startedFirst);
        const secondCall = yield* action(
          definition,
          "observe",
          { ...second.native, vars },
          startedSecond,
          releaseSecond,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(startedSecond);
        yield* Deferred.succeed(releaseSecond, undefined);
        expect(yield* Fiber.join(secondCall)).toBe("second");
        yield* Deferred.succeed(releaseFirst, undefined);
        expect(yield* Fiber.join(firstCall)).toBe("first");
        yield* drain(first.pending);
        yield* drain(second.pending);
        expect(constructions).toBe(1);
        expect(first.native.state.kv.owner).toBe("first");
        expect(second.native.state.kv.owner).toBe("second");
        expect(activation.native.state.kv).toEqual({});
        expect(activation.pending).toHaveLength(0);
        expect(first.pending.length).toBeGreaterThanOrEqual(2);
        expect(second.pending.length).toBeGreaterThanOrEqual(2);
        expect(deferred.sort()).toEqual(["first", "second"]);
        expect(finalized.sort()).toEqual(["first", "second"]);
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "forwards deferred failures to native lifetime tracking",
    () =>
      Effect.gen(function* () {
        const { native, pending } = makeNative("failure");
        const state = fromRivetActor(native, new Map());
        const failure = new Error("deferred failure");
        yield* state
          .waitUntil(Effect.die(failure))
          .pipe(Effect.provideService(NativeContext, native));
        expect(pending).toHaveLength(1);
        const exit = yield* Effect.exit(Effect.promise(() => pending[0]));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(String(Cause.squash(exit.cause))).toContain(
            "deferred failure",
          );
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "returns socket callback promises and keeps native socket operations truthful",
    () =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const definition = register(
          Effect.gen(function* () {
            const state = yield* DurableObjectState;
            return Effect.succeed({
              webSocketMessage: () =>
                state.raw.pipe(
                  Effect.map((native) => {
                    seen.push(native.actorId);
                  }),
                ),
              webSocketError: () => Effect.die(new Error("socket failure")),
              webSocketClose: () =>
                state.getWebSockets().pipe(
                  Effect.map((sockets) => {
                    expect(sockets).toHaveLength(0);
                  }),
                ),
            });
          }),
          [],
        );
        const { native, pending } = makeNative("socket");
        const vars = yield* Effect.promise(() => definition.createVars(native));
        const { socket, listeners, sent, closed } = makeSocket();
        yield* Effect.promise(() =>
          Promise.resolve(definition.onWebSocket({ ...native, vars }, socket)),
        );
        const message = listeners.get("message")!({
          type: "message",
          data: "hello",
        });
        expect(message).toBeInstanceOf(Promise);
        if (message === undefined)
          throw new Error("Message callback did not return its promise");
        yield* Effect.promise(() => message);
        expect(seen).toEqual(["socket"]);
        const failure = listeners.get("error")!({ type: "error" });
        expect(failure).toBeInstanceOf(Promise);
        if (failure === undefined)
          throw new Error("Error callback did not return its promise");
        expect(
          Exit.isFailure(yield* Effect.exit(Effect.promise(() => failure))),
        ).toBe(true);
        const close = listeners.get("close")!({
          type: "close",
          code: 1000,
          reason: "done",
          wasClean: true,
        });
        if (close === undefined)
          throw new Error("Close callback did not return its promise");
        yield* Effect.promise(() => close);
        const wrapped = fromWebSocket(socket, native.conn!);
        expect(wrapped.ws).toBe(socket);
        expect("accept" in wrapped).toBe(false);
        yield* wrapped.setAttachment(Schema.Struct({ name: Schema.String }), {
          name: "retained",
        });
        expect(native.conn!.state.attachment).toEqual({ name: "retained" });
        yield* Effect.gen(function* () {
          yield* wrapped.send("reply");
          yield* wrapped.close(1000, "done");
        }).pipe(Effect.provideService(NativeContext, native));
        expect(sent).toEqual(["reply"]);
        expect(closed).toEqual([[1000, "done"]]);
        yield* drain(pending);
      }),
    { timeout: 5_000 },
  );

  it.effect(
    "registers without constructing a probe and initializes SQL only on native activation",
    () =>
      Effect.gen(function* () {
        let constructions = 0;
        const definition = register(
          Effect.gen(function* () {
            const state = yield* DurableObjectState;
            return Effect.gen(function* () {
              constructions++;
              yield* state.storage.sql.exec("SELECT 1");
              return { read: () => Effect.succeed(42) };
            });
          }),
          [],
        );
        expect(constructions).toBe(0);
        const { native, pending } = makeNative("sql-activation");
        const vars = yield* Effect.promise(() => definition.createVars(native));
        expect(constructions).toBe(1);
        expect(
          yield* action(
            definition,
            CALL_ACTION,
            { ...native, vars },
            "read",
            [],
          ),
        ).toBe(42);
        const rejected = yield* action(
          definition,
          CALL_ACTION,
          { ...native, vars },
          "toString",
          [],
        ).pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        yield* drain(pending);
        yield* Effect.promise(() => definition.onSleep({ ...native, vars }));
      }),
    { timeout: 5_000 },
  );
});
