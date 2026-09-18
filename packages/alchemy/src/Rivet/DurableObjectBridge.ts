/**
 * Rivet activation, action, alarm, and socket delivery over the shared instance
 * core. Stream RPC results are collected because the native action transport
 * cannot carry a ReadableStream.
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { RivetCloseEvent, RivetMessageEvent } from "rivetkit";
import type { DurableObjectExport } from "../Workers/DurableObject.ts";
import {
  makeDurableObjectInstance,
  RESERVED_DURABLE_OBJECT_HANDLERS,
  type DurableObjectInstance,
} from "../Workers/DurableObjectBridge.ts";
import {
  handleRpcExit,
  type Pin,
  type WorkerBuild,
} from "../Workers/Worker.ts";
import { toRpcEffect } from "../Workers/WorkerBridge.ts";
import {
  ALARM_ACTION,
  consumeAlarm,
  DurableObjectState,
  fromRivetActor,
  isAlarmCurrent,
  NativeContext,
  type RivetActorContext,
} from "./DurableObjectState.ts";
import {
  fromWebSocket,
  type RawWebSocket,
  type WebSocket,
} from "./WebSocket.ts";

/** The native factory boundary used by the runner and unit tests. */
export type RivetActorFactory = (config: {
  db?: unknown;
  createState: () => { kv: Record<string, unknown> };
  createVars: (c: RivetActorContext) => Promise<unknown>;
  actions: Record<
    string,
    (c: RivetActorContext, ...args: any[]) => Promise<unknown> | undefined
  >;
  onWebSocket: (c: RivetActorContext, websocket: RawWebSocket) => void;
  options: { canHibernateWebSocket: boolean };
}) => unknown;

interface RivetActorVars {
  readonly core: DurableObjectInstance;
  readonly sockets: Map<RawWebSocket, readonly string[]>;
}

/** Only the heterogeneous shared export boundary erases provider handlers. */
interface RivetInstanceShape {
  alarm?: () => Effect.Effect<unknown, unknown, any>;
  webSocketMessage?: (
    socket: WebSocket,
    message: RivetMessageEvent["data"],
  ) => Effect.Effect<unknown, unknown, any>;
  webSocketClose?: (
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) => Effect.Effect<unknown, unknown, any>;
  webSocketError?: (
    socket: WebSocket,
    error: unknown,
  ) => Effect.Effect<unknown, unknown, any>;
}

const invocation = (native: RivetActorContext) => ({
  services: Context.make(NativeContext, native),
  waitUntil: (promise: Promise<unknown>) => native.waitUntil(promise),
});

const collectingStreams = (result: unknown) =>
  toRpcEffect(result).pipe(
    Effect.flatMap((value) =>
      Stream.isStream(value)
        ? Stream.runCollect(value as Stream.Stream<unknown, unknown, any>).pipe(
            Effect.map((chunk) => [...chunk]),
          )
        : Effect.succeed(value),
    ),
  );

/**
 * Discover RPC names with an explicit actor-state-only probe. SQL or scheduler
 * access during discovery fails startup rather than registering an empty actor.
 */
export const discoverDurableObjectMethods = async (
  build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>,
): Promise<string[]> => {
  const pending: Promise<unknown>[] = [];
  const unavailable = () => {
    throw new Error(
      "Rivet method discovery cannot execute native SQL or scheduling during initialization",
    );
  };
  const probe: RivetActorContext = {
    actorId: "__alchemy_method_probe",
    state: { kv: {} },
    key: ["__alchemy_method_probe"],
    name: "__alchemy_method_probe",
    db: { execute: unavailable, transaction: unavailable, close: unavailable },
    schedule: {
      at: unavailable,
      after: unavailable,
      cancel: unavailable,
      get: unavailable,
      list: unavailable,
    },
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  const { instance } = await makeDurableObjectInstance({
    build,
    services: Context.make(
      DurableObjectState,
      fromRivetActor(probe, new Map()),
    ).pipe(Context.add(NativeContext, probe)),
    waitUntil: probe.waitUntil,
    dispatch: "proxy",
  }).instance;
  await Promise.all(pending);
  return Object.keys(instance).filter(
    (name) => !RESERVED_DURABLE_OBJECT_HANDLERS.has(name),
  );
};

/** Register one native actor with one user constructor per activation. */
export const makeRivetActor = (
  actor: RivetActorFactory,
  {
    build,
    methods,
    db,
  }: {
    build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>;
    methods: readonly string[];
    db?: unknown;
  },
) => {
  const varsOf = (native: RivetActorContext): RivetActorVars => {
    const vars = native.vars as RivetActorVars | undefined;
    if (vars === undefined) {
      throw new Error(
        "Rivet actor vars missing: createVars must run before action delivery",
      );
    }
    return vars;
  };

  return actor({
    ...(db !== undefined ? { db } : {}),
    createState: () => ({ kv: {} }),
    options: { canHibernateWebSocket: true },
    createVars: async (native) => {
      const sockets = new Map<RawWebSocket, readonly string[]>();
      const vars: RivetActorVars = {
        sockets,
        core: makeDurableObjectInstance({
          build,
          services: Context.make(
            DurableObjectState,
            fromRivetActor(native, sockets),
          ).pipe(Context.add(NativeContext, native)),
          waitUntil: invocation(native).waitUntil,
          dispatch: "proxy",
        }),
      };
      await vars.core.instance;
      return vars;
    },
    onWebSocket: (native, websocket) => {
      const { core, sockets } = varsOf(native);
      sockets.set(websocket, []);
      const socket = fromWebSocket(websocket);
      // Rivet tracks the returned callback promise and opens its native region.
      websocket.addEventListener("message", (event: RivetMessageEvent) =>
        core.execute<void>(
          (instance) =>
            (instance as RivetInstanceShape).webSocketMessage?.(
              socket,
              event.data,
            ) ?? Effect.void,
          undefined,
          invocation(native),
        ),
      );
      websocket.addEventListener("error", (event: unknown) =>
        core.execute<void>(
          (instance) =>
            (instance as RivetInstanceShape).webSocketError?.(socket, event) ??
            Effect.void,
          undefined,
          invocation(native),
        ),
      );
      websocket.addEventListener("close", (event: RivetCloseEvent) => {
        sockets.delete(websocket);
        return core.execute<void>(
          (instance) =>
            (instance as RivetInstanceShape).webSocketClose?.(
              socket,
              event.code,
              event.reason,
              event.wasClean,
            ) ?? Effect.void,
          undefined,
          invocation(native),
        );
      });
    },
    actions: {
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (native: RivetActorContext, ...args: unknown[]) =>
            varsOf(native).core.execute(
              (instance) => {
                const member = instance[method];
                return collectingStreams(
                  typeof member === "function" ? member(...args) : member,
                );
              },
              handleRpcExit,
              invocation(native),
            ),
        ]),
      ),
      [ALARM_ACTION]: (native: RivetActorContext, generation: number) => {
        const { core } = varsOf(native);
        if (!isAlarmCurrent(native.state, generation)) return;
        consumeAlarm(native.state);
        return core.execute(
          (instance) =>
            (instance as RivetInstanceShape).alarm?.() ?? Effect.void,
          undefined,
          invocation(native),
        );
      },
    },
  });
};
