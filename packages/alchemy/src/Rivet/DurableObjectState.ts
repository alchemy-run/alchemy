import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { ActorContext } from "rivetkit";
import type { DatabaseProvider, RawAccess } from "rivetkit/db";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { CallbackJob } from "../Workers/CallbackRegistry.ts";
import {
  fromRivetStorage,
  type DurableObjectStorage,
} from "./DurableObjectStorage.ts";
import {
  fromWebSocket,
  type ConnectedSocket,
  type RivetConnection,
  type WebSocket,
} from "./WebSocket.ts";

/** The reserved native action used to deliver an alarm. */
export const ALARM_ACTION = "__alchemyAlarm";

/** Persisted state owned by the Rivet Durable Object adapter. */
export interface RivetActorState {
  /** Values persisted through Rivet's actor-state write-through proxy. */
  kv: Record<string, unknown>;
  /** Next RPC connection identifier, including sockets dormant outside this activation. */
  rpcNextClientId?: number;
  /** The current native scheduled event and its generation. */
  alarm?: { time: number; generation: number; scheduleId?: string };
  /** Monotonic generation that rejects stale alarm deliveries. */
  alarmGeneration?: number;
  /** Versioned callback jobs; independent of user KV and SQLite. */
  callbacks?: Record<string, CallbackJob>;
  /** Optional precise wake; the recurring native watchdog is authoritative recovery. */
  callbackWake?: { id: string; at: number };
}

type NativeActor = ActorContext<
  RivetActorState,
  unknown,
  unknown,
  unknown,
  unknown,
  DatabaseProvider<RawAccess>
>;

/** The native actor context members used by this adapter. */
export interface RivetActorContext extends Pick<
  NativeActor,
  | "actorId"
  | "key"
  | "name"
  | "state"
  | "db"
  | "schedule"
  | "waitUntil"
  | "saveState"
  | "cron"
  | "abortSignal"
  | "keepAwake"
  | "sleep"
  | "destroy"
> {
  /** Activation-local vars are absent while createVars is running. */
  readonly vars?: unknown;
  /** Present on native socket and action invocations, absent during activation. */
  readonly conn?: RivetConnection;
}

/** @internal Runtime-colored lookup of the originating native invocation. */
export const NativeContext = Context.Service<RuntimeContext, RivetActorContext>(
  "Rivet.NativeContext",
);

/** Rivet actor identity, storage, lifetime tracking, and connected sockets. */
export class DurableObjectState extends Context.Service<
  DurableObjectState,
  {
    /** Native Rivet actor identifier. */
    readonly actorId: string;
    /** Native actor key, including all key components. */
    readonly key: readonly string[];
    /** Registered native actor name. */
    readonly name: string;
    /** Actor-state KV, embedded SQLite, and scheduled alarms. */
    readonly storage: DurableObjectStorage;
    /** The originating action's native context, resolved when run. */
    readonly raw: Effect.Effect<RivetActorContext, never, RuntimeContext>;
    /** Register deferred work with the originating native context. */
    waitUntil<A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<void, never, R | RuntimeContext>;
    /** Set persistent connection tags on an already accepted Rivet socket. */
    setWebSocketTags(
      socket: WebSocket,
      tags: readonly string[],
    ): Effect.Effect<void, never, RuntimeContext>;
    /** Connected sockets registered during this activation. */
    getWebSockets(
      tag?: string,
    ): Effect.Effect<WebSocket[], never, RuntimeContext>;
    /** Activation-local tags associated with a connected socket. */
    getTags(
      socket: WebSocket,
    ): Effect.Effect<readonly string[], never, RuntimeContext>;
  }
>()("Rivet.DurableObjectState") {}

export const isAlarmCurrent = (
  state: RivetActorState,
  generation: number,
): boolean => state.alarm?.generation === generation;

export const consumeAlarm = (state: RivetActorState): void => {
  state.alarm = undefined;
};

/** @internal Construct once; native operations resolve their invocation lazily. */
export const fromRivetActor = (
  actor: Pick<RivetActorContext, "actorId" | "key" | "name">,
  sockets: Map<string, ConnectedSocket>,
): DurableObjectState["Service"] => ({
  actorId: actor.actorId,
  key: actor.key,
  name: actor.name,
  storage: fromRivetStorage(),
  raw: NativeContext,
  waitUntil: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const native = yield* NativeContext;
      const context = yield* Effect.context<R>();
      yield* Effect.sync(() =>
        native.waitUntil(
          Effect.runPromise(effect.pipe(Effect.provide(context))),
        ),
      );
    }),
  setWebSocketTags: (socket, tags) =>
    Effect.sync(() => {
      const connected = sockets.get(socket.id);
      if (connected?.socket !== socket.ws) {
        throw new Error("The socket is not connected to this Rivet actor");
      }
      connected.connection.state.tags = [...tags];
    }),
  getWebSockets: (tag) =>
    Effect.sync(() =>
      [...sockets.values()]
        .filter(
          ({ connection }) =>
            tag === undefined || connection.state.tags.includes(tag),
        )
        .map(({ socket, connection }) => fromWebSocket(socket, connection)),
    ),
  getTags: (socket) =>
    Effect.sync(() => [
      ...(sockets.get(socket.id)?.connection.state.tags ?? []),
    ]),
});
