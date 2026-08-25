/**
 * The Rivet runtime bridge: adapt an `Alchemy.DurableObject` export into a
 * Rivet actor definition.
 *
 * The Cloudflare-family engines (workerd, celld) share
 * `makeDurableObjectBridge`, which needs `cloudflare:workers`. Rivet runs
 * user code in an ordinary Node/Bun process, so it gets its own bridge —
 * this file is the proof that the portable Durable Object authoring
 * surface is not secretly workerd-shaped.
 *
 * The mapping:
 *
 * - the export's two-phase Effect (init → per-instance) runs once per
 *   actor instance, memoized on the actor context;
 * - every method on the resulting shape becomes a Rivet `action`, with
 *   Effect results run to completion and `Stream`s collected;
 * - `alarm` is delivered through a reserved action scheduled by
 *   `storage.setAlarm` (see `ActorState.ts` for the cancellation story);
 * - `webSocketMessage` / `webSocketClose` are driven from Rivet's
 *   `onWebSocket` hook with hibernation enabled;
 * - {@link DurableObjectState} is served from the actor's persisted state,
 *   per-actor SQLite, and scheduler.
 *
 * @internal consumed by the generated runner entry, not by user code.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { DurableObjectExport } from "../Cloudflare/Workers/DurableObject.ts";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";
import { ErrorTag, encodeRpcError, type RpcErrorEnvelope } from "../Rpc.ts";
import {
  ALARM_ACTION,
  consumeAlarm,
  fromRivetState,
  isAlarmCurrent,
  type RivetActorState,
} from "./ActorState.ts";

/** The subset of the Rivet `actor()` factory this bridge depends on. */
export type RivetActorFactory = (config: {
  db?: unknown;
  createState: () => RivetActorState;
  actions: Record<string, (c: any, ...args: any[]) => unknown>;
  onWebSocket?: (c: any, websocket: any) => void | Promise<void>;
  options?: { canHibernateWebSocket?: boolean };
}) => unknown;

/** A built Durable Object instance plus the context it runs under. */
interface BuiltInstance {
  readonly instance: Record<string, any>;
  readonly context: Context.Context<never>;
}

/**
 * The per-actor WebSocket registry backing `acceptWebSocket` /
 * `getWebSockets`. Ephemeral by design: workerd rebuilds its socket set
 * after a hibernation wake, and Rivet re-delivers through `onWebSocket`.
 */
const socketRegistries = new WeakMap<object, Map<any, string[]>>();
const registryFor = (c: object) => {
  let registry = socketRegistries.get(c);
  if (registry === undefined) {
    registry = new Map();
    socketRegistries.set(c, registry);
  }
  return registry;
};

/**
 * Adapt one Durable Object export into a Rivet actor definition.
 *
 * `methods` is the plan-time-discovered RPC surface: Rivet reads its
 * `actions` map once at registration, so (unlike a Proxy-based bridge) the
 * names must be known before any instance exists.
 */
export const makeRivetActor = (
  actor: RivetActorFactory,
  {
    export: exported,
    methods,
    db,
  }: {
    export: DurableObjectExport;
    methods: readonly string[];
    /** `rivetkit/db`'s `db({...})` value — declared for every DO so
     *  `storage.sql` is always available. */
    db?: unknown;
  },
) => {
  const builds = new WeakMap<object, Promise<BuiltInstance>>();

  const makeState = (c: any) =>
    ({
      // Rivet addresses actors by key; expose it where workerd exposes the
      // Durable Object id.
      id: { toString: () => String(c.key?.[0] ?? c.name ?? "") } as any,
      storage: fromRivetState(c),
      raw: c,
      // Rivet keeps the actor alive for its own task; run detached from
      // the caller's response.
      waitUntil: (effect: Effect.Effect<any, any, any>) =>
        Effect.sync(() => {
          void Effect.runPromise(effect as Effect.Effect<any, never, never>);
        }),
      // Rivet actions are not serialized (see ActorState.ts) — this runs
      // the callback without workerd's input-gate exclusivity.
      blockConcurrencyWhile: (callback: () => Effect.Effect<any>) => callback(),
      acceptWebSocket: (ws: any, tags?: string[]) =>
        Effect.sync(() => {
          registryFor(c).set(ws, tags ?? []);
        }),
      getWebSockets: (tag?: string) =>
        Effect.sync(() =>
          [...registryFor(c).entries()]
            .filter(([, tags]) => tag === undefined || tags.includes(tag))
            .map(([ws]) => ws),
        ),
      getTags: (ws: any) => Effect.sync(() => registryFor(c).get(ws) ?? []),
      // Rivet has no auto-response or per-socket event timeout knob.
      setWebSocketAutoResponse: () => unsupportedAutoResponse,
      getWebSocketAutoResponse: () => Effect.succeed(undefined),
      getWebSocketAutoResponseTimestamp: () => Effect.succeed(undefined),
      setHibernatableWebSocketEventTimeout: () => Effect.void,
      getHibernatableWebSocketEventTimeout: () => Effect.succeed(undefined),
      abort: () => Effect.void,
    }) as any;

  const unsupportedAutoResponse = Effect.die(
    new Error(
      "WebSocket auto-response has no Rivet equivalent — handle the ping " +
        "in `webSocketMessage`.",
    ),
  );

  const build = (c: any): Promise<BuiltInstance> => {
    const existing = builds.get(c);
    if (existing !== undefined) {
      return existing;
    }
    const doContext = Layer.succeed(DurableObjectState, makeState(c)).pipe(
      Layer.provideMerge(Layer.succeedContext(exported.services)),
    );
    const built = Effect.runPromise(
      (exported.constructor as Effect.Effect<any, never, any>).pipe(
        Effect.provide(doContext),
        Effect.flatMap((instance) => instance.pipe(Effect.provide(doContext))),
        Effect.map((instance): BuiltInstance => ({
          instance: instance as Record<string, any>,
          context: exported.services,
        })),
      ) as Effect.Effect<BuiltInstance>,
    );
    builds.set(c, built);
    return built;
  };

  /** Run one Effect/Stream result under a fresh per-call scope. */
  const run = async (c: any, context: Context.Context<never>, result: any) => {
    const scope = Scope.makeUnsafe();
    const effect = Effect.isEffect(result)
      ? (result as Effect.Effect<any, any, any>)
      : Stream.isStream(result)
        ? Stream.runCollect(result as Stream.Stream<any, any, any>).pipe(
            Effect.map((chunk) => [...chunk]),
          )
        : Effect.succeed(result);
    const exit = await Effect.runPromiseExit(
      (effect as Effect.Effect<any, any, any>).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(DurableObjectState, makeState(c)),
            Layer.succeed(Scope.Scope, scope),
          ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
        ),
      ) as Effect.Effect<any, any>,
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
    return exit;
  };

  const invoke = async (c: any, method: string, args: unknown[]) => {
    const { instance, context } = await build(c);
    const member = instance[method];
    const exit = await run(
      c,
      context,
      typeof member === "function" ? member(...args) : member,
    );
    if (exit._tag === "Success") {
      return exit.value;
    }
    const failure = exit.cause.reasons.find(Cause.isFailReason);
    if (failure) {
      // Typed failures are RETURNED as an error envelope, not thrown:
      // Rivet's action-error path erases the payload to a generic
      // `internal_error`, so a thrown tagged error would reach the caller
      // untyped. The envelope keeps `Effect.fail` recoverable end to end.
      return {
        _tag: ErrorTag,
        error: encodeRpcError(failure.error),
      } satisfies RpcErrorEnvelope;
    }
    // Defects stay defects — they are bugs, not part of the contract.
    const defect = exit.cause.reasons.find(Cause.isDieReason);
    throw defect?.defect ?? new Error(`RPC method "${method}" failed`);
  };

  /** Dispatch a lifecycle handler (alarm / websocket) if the shape has it. */
  const dispatch = async (c: any, handler: string, args: unknown[]) => {
    const { instance, context } = await build(c);
    const member = instance[handler];
    if (typeof member !== "function") {
      return;
    }
    const exit = await run(c, context, member(...args));
    if (exit._tag === "Failure") {
      throw Cause.squash(exit.cause);
    }
  };

  return actor({
    ...(db !== undefined ? { db } : {}),
    createState: () => ({ kv: {} }),
    options: { canHibernateWebSocket: true },
    onWebSocket: (c: any, websocket: any) => {
      // Rivet delivers an already-accepted socket. Register it so
      // `getWebSockets` sees it even if the user never calls
      // `acceptWebSocket` (workerd requires that call; here it only adds
      // tags), then bridge events onto the portable handlers.
      const registry = registryFor(c);
      if (!registry.has(websocket)) {
        registry.set(websocket, []);
      }
      websocket.addEventListener?.("message", (event: any) => {
        void dispatch(c, "webSocketMessage", [websocket, event?.data]);
      });
      websocket.addEventListener?.("close", (event: any) => {
        registry.delete(websocket);
        void dispatch(c, "webSocketClose", [
          websocket,
          event?.code ?? 1000,
          event?.reason ?? "",
          event?.wasClean ?? true,
        ]);
      });
    },
    actions: {
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (c: any, ...args: unknown[]) => invoke(c, method, args),
        ]),
      ),
      // Reserved: delivers `storage.setAlarm`. Generation-guarded because
      // Rivet's scheduler has no cancel (see ActorState.ts).
      [ALARM_ACTION]: async (c: any, generation: number) => {
        const state = c.state as RivetActorState;
        if (!isAlarmCurrent(state, generation)) {
          return;
        }
        consumeAlarm(state);
        await dispatch(c, "alarm", [undefined]);
      },
    },
  });
};
