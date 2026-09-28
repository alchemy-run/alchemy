/**
 * Rivet activation, action, alarm, and socket delivery over the shared instance
 * core. Stream RPC results are collected because the native action transport
 * cannot carry a ReadableStream.
 *
 * @internal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
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
import { CALLBACK_ACTION, makeRivetCallbacks } from "./AlarmCallback.ts";
import { registerConnection } from "./RpcWebSocket.ts";
import { RpcActivationScope } from "../Workers/RpcDurableObject.ts";
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
  type ConnectedSocket,
  type RivetConnectionState,
  type WebSocket,
} from "./WebSocket.ts";

/** The native factory boundary used by the runner and unit tests. */
export type RivetActorFactory = (config: {
  db?: unknown;
  createState: () => { kv: Record<string, unknown> };
  createVars: (c: RivetActorContext) => Promise<unknown>;
  createConnState: () => RivetConnectionState;
  onSleep: (c: RivetActorContext) => Promise<void>;
  onDestroy: (c: RivetActorContext) => Promise<void>;
  actions: Record<
    string,
    (c: RivetActorContext, ...args: any[]) => Promise<unknown> | undefined
  >;
  onWebSocket: (
    c: RivetActorContext,
    websocket: RawWebSocket,
  ) => Promise<void> | void;
  options: { canHibernateWebSocket: boolean };
}) => unknown;

interface RivetActorVars {
  readonly core: DurableObjectInstance;
  readonly sockets: Map<string, ConnectedSocket>;
  readonly close: () => Promise<void>;
  readonly callbacks: ReturnType<typeof makeRivetCallbacks>;
}

/** Only the heterogeneous shared export boundary erases provider handlers. */
interface RivetInstanceShape {
  webSocketOpen?: (socket: WebSocket) => Effect.Effect<unknown, unknown, any>;
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

const interruptOnRetirement = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  native: RivetActorContext,
) =>
  Effect.raceFirst(
    effect,
    Effect.callback<never>((resume) => {
      const interrupt = () => resume(Effect.interrupt);
      if (native.abortSignal.aborted) interrupt();
      else
        native.abortSignal.addEventListener("abort", interrupt, { once: true });
      return Effect.sync(() =>
        native.abortSignal.removeEventListener("abort", interrupt),
      );
    }),
  );

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

/** Native registration is fixed; user methods are resolved only after activation. */
export const CALL_ACTION = "__alchemyCall";

const callMember = (
  instance: Record<string, unknown>,
  method: string,
  args: unknown[],
) => {
  if (
    typeof method !== "string" ||
    method.startsWith("__alchemy") ||
    method === "webSocketOpen" ||
    RESERVED_DURABLE_OBJECT_HANDLERS.has(method) ||
    !Object.hasOwn(instance, method)
  ) {
    return Effect.die(new Error(`Unknown Rivet method: ${method}`));
  }
  const member = instance[method];
  return collectingStreams(
    typeof member === "function" ? member(...args) : member,
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

  const execute = <T = unknown>(
    native: RivetActorContext,
    fn: Parameters<DurableObjectInstance["execute"]>[0],
    onExit?: (exit: Exit.Exit<any, any>, scope: Scope.Closeable) => Promise<T>,
  ) =>
    varsOf(native).core.execute<T>(
      (instance) => interruptOnRetirement(fn(instance), native),
      onExit,
      invocation(native),
    );

  return actor({
    ...(db !== undefined ? { db } : {}),
    createState: () => ({ kv: {} }),
    options: { canHibernateWebSocket: true },
    createConnState: () => ({ version: 1, tags: [] }),
    onSleep: (native) => varsOf(native).close(),
    onDestroy: (native) => varsOf(native).close(),
    createVars: async (native) => {
      const sockets = new Map<string, ConnectedSocket>();
      const scope = Scope.makeUnsafe();
      const callbacks = makeRivetCallbacks();
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= Effect.runPromise(Scope.close(scope, Exit.void)));
      const onAbort = () => {
        native.waitUntil(close());
      };
      native.abortSignal.addEventListener("abort", onAbort, { once: true });
      await Effect.runPromise(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            native.abortSignal.removeEventListener("abort", onAbort);
            sockets.clear();
          }),
        ),
      );
      const vars: RivetActorVars = {
        sockets,
        close,
        callbacks,
        core: makeDurableObjectInstance({
          build,
          runtimeContext: (runtime) => ({
            ...runtime,
            makeCallback: callbacks.factory,
          }),
          initialize: callbacks.initialize,
          services: Context.make(
            DurableObjectState,
            fromRivetActor(native, sockets),
          ).pipe(
            Context.add(NativeContext, native),
            Context.add(Scope.Scope, scope),
            Context.add(RpcActivationScope, scope),
          ),
          waitUntil: invocation(native).waitUntil,
          dispatch: "proxy",
        }),
      };
      try {
        await vars.core.instance;
        return vars;
      } catch (error) {
        await close();
        throw error;
      }
    },
    onWebSocket: (native, websocket) => {
      const { sockets } = varsOf(native);
      const connection = native.conn;
      if (connection === undefined)
        throw new Error("Rivet socket delivery requires conn");
      if (connection.state?.version !== 1) {
        websocket.close(1012, "Unsupported connection state; reconnect");
        return;
      }
      sockets.set(connection.id, { socket: websocket, connection });
      const socket = fromWebSocket(websocket, connection);
      registerConnection(socket, connection, native);
      // Rivet tracks the returned callback promise and opens its native region.
      websocket.addEventListener("message", (event: RivetMessageEvent) =>
        execute<void>(
          native,
          (instance) =>
            (instance as RivetInstanceShape).webSocketMessage?.(
              socket,
              event.data,
            ) ?? Effect.void,
        ),
      );
      websocket.addEventListener("error", (event: unknown) =>
        execute<void>(
          native,
          (instance) =>
            (instance as RivetInstanceShape).webSocketError?.(socket, event) ??
            Effect.void,
        ),
      );
      websocket.addEventListener("close", (event: RivetCloseEvent) => {
        sockets.delete(connection.id);
        return execute<void>(
          native,
          (instance) =>
            (instance as RivetInstanceShape).webSocketClose?.(
              socket,
              event.code,
              event.reason,
              event.wasClean,
            ) ?? Effect.void,
        );
      });
      return execute<void>(
        native,
        (instance) =>
          (instance as RivetInstanceShape).webSocketOpen?.(socket) ??
          Effect.void,
      );
    },
    actions: {
      [CALLBACK_ACTION]: (native: RivetActorContext) => {
        const vars = varsOf(native);
        return execute(native, () => vars.callbacks.dispatch());
      },
      [CALL_ACTION]: (
        native: RivetActorContext,
        method: string,
        args: unknown[],
      ) =>
        execute(
          native,
          (instance) =>
            Array.isArray(args)
              ? callMember(instance, method, args)
              : Effect.die(
                  new Error("Rivet method arguments must be an array"),
                ),
          handleRpcExit,
        ),
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (native: RivetActorContext, ...args: unknown[]) =>
            execute(
              native,
              (instance) => callMember(instance, method, args),
              handleRpcExit,
            ),
        ]),
      ),
      [ALARM_ACTION]: (native: RivetActorContext, generation: number) => {
        if (!isAlarmCurrent(native.state, generation)) return;
        consumeAlarm(native.state);
        return execute(
          native,
          (instance) =>
            (instance as RivetInstanceShape).alarm?.() ?? Effect.void,
        );
      },
    },
  });
};
