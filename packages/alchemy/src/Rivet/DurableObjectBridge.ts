/**
 * The rivetkit actor adapter over the engine-invariant Durable Object
 * instance core: one `Cloudflare.DurableObject` class export becomes one
 * Rivet actor definition.
 *
 * - the instance builds ONCE per actor instance, in rivetkit's
 *   `createVars` hook (the per-instance lifecycle hook whose value the
 *   runtime keeps for the actor's lifetime — a fresh
 *   `ActorContextHandleAdapter` is minted per action and disposed after
 *   it, so the per-call context is not an identity);
 * - every method on the built shape becomes a Rivet `action` served by the
 *   core's `execute` + exit encoding;
 * - `alarm` is delivered through a reserved action scheduled by
 *   `storage.setAlarm` (see `DurableObject.ts` for the cancellation story);
 * - `webSocketMessage` / `webSocketClose` are driven from Rivet's
 *   `onWebSocket` hook with hibernation enabled.
 *
 * **Rivet transport limitation — streams are collected.** rivetkit
 * encodes an action's return value for its wire (`encodeValue`), which
 * cannot carry the core's `ReadableStream`-bearing stream envelope. A
 * `Stream`-returning method is therefore drained inside the call scope and
 * returned as an array; the gateway stub's stream form re-expands the
 * array into elements (see `Gateway.ts`), so callers still see a `Stream`
 * of the original values — buffered, not incremental.
 *
 * @internal consumed by the generated runner entry, not by user code.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { DurableObjectExport } from "../Workers/DurableObject.ts";
import {
  makeDurableObjectInstance,
  RESERVED_DURABLE_OBJECT_HANDLERS,
  type DurableObjectInstance,
} from "../Workers/DurableObjectBridge.ts";
import { fromWebSocket, type RawWebSocket } from "../Workers/WebSocket.ts";
import {
  handleRpcExit,
  type Pin,
  type WorkerBuild,
} from "../Workers/Worker.ts";
import { toRpcEffect } from "../Workers/WorkerBridge.ts";
import {
  ALARM_ACTION,
  consumeAlarm,
  fromRivetActor,
  isAlarmCurrent,
  type RivetActorContext,
} from "./DurableObject.ts";

/** The subset of the Rivet `actor()` factory this bridge depends on. */
export type RivetActorFactory = (config: {
  db?: unknown;
  createState: () => { kv: Record<string, unknown> };
  createVars: (c: RivetActorContext) => Promise<unknown>;
  actions: Record<string, (c: RivetActorContext, ...args: any[]) => unknown>;
  onWebSocket?: (c: RivetActorContext, websocket: any) => void;
  options?: { canHibernateWebSocket?: boolean };
}) => unknown;

/** The per-actor-instance value rivetkit keeps under `c.vars`. */
interface RivetActorVars {
  readonly core: DurableObjectInstance;
  /** The actor's WebSocket registry (`acceptWebSocket` / `getWebSockets`). */
  readonly sockets: Map<RawWebSocket, string[]>;
  /** The slot the state service reads the latest per-call context through. */
  readonly slot: { current: RivetActorContext };
}

/** Rivet keeps the actor alive for its own task; nothing to pin. */
const noPin: Pin = () => undefined;

/**
 * Run one shape member under the core's call scope, draining a `Stream`
 * result to an array (the Rivet transport limitation above) so the exit
 * `handleRpcExit` encodes is always a plain value or a typed failure.
 */
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
 * Discover a Durable Object export's RPC surface by building ONE throwaway
 * instance against a detached in-memory actor context and reading the
 * shape's keys.
 *
 * Rivet reads an actor's `actions` map once at registration, so the method
 * names must be known before any real instance exists. Instances that
 * perform SQL-dependent init in their per-instance effect fail the probe —
 * the runner then registers no actions for the class and logs the failure.
 */
export const discoverDurableObjectMethods = (
  build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>,
): Promise<string[]> => {
  const probe: RivetActorContext = {
    state: { kv: {} },
    key: ["__alchemy_method_probe"],
  };
  return makeDurableObjectInstance({
    build,
    state: fromRivetActor(() => probe, new Map()),
    waitUntil: noPin,
    dispatch: "proxy",
  }).instance.then(({ instance }) =>
    Object.keys(instance).filter(
      (name) => !RESERVED_DURABLE_OBJECT_HANDLERS.has(name),
    ),
  );
};

/**
 * Adapt one Durable Object export into a Rivet actor definition.
 *
 * `methods` is the runner-boot-discovered RPC surface: Rivet reads its
 * `actions` map once at registration, so (unlike a Proxy-based bridge) the
 * names must be known before any instance exists.
 */
export const makeRivetActor = (
  actor: RivetActorFactory,
  {
    build,
    methods,
    db,
  }: {
    /** The class export resolved against the runner's shared build. */
    build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>;
    methods: readonly string[];
    /** `rivetkit/db`'s `db({...})` value — declared for every DO so
     *  `storage.sql` is always available. */
    db?: unknown;
  },
) => {
  /** The instance built at actor start, refreshed with this call's context. */
  const varsOf = (
    c: RivetActorContext & { vars?: unknown },
  ): RivetActorVars => {
    const vars = c.vars as RivetActorVars | undefined;
    if (vars === undefined) {
      throw new Error(
        "Rivet actor vars missing — the actor started without running " +
          "createVars (a rivetkit bridge bug).",
      );
    }
    vars.slot.current = c;
    return vars;
  };

  return actor({
    ...(db !== undefined ? { db } : {}),
    createState: () => ({ kv: {} }),
    options: { canHibernateWebSocket: true },
    // Build-once per actor instance: rivetkit runs `createVars` on every
    // actor start (first create and each wake) and keeps the value for the
    // instance's lifetime, so this is the Rivet analogue of workerd's
    // constructor + `blockConcurrencyWhile` gate. Awaiting the build here
    // fails actor start on a failed init instead of failing every call.
    createVars: async (c) => {
      const sockets = new Map<RawWebSocket, string[]>();
      // The state service reads the actor context lazily through this
      // slot, which every later action refreshes (see `varsOf`).
      const slot = { current: c };
      const vars: RivetActorVars = {
        slot,
        sockets,
        core: makeDurableObjectInstance({
          build,
          state: fromRivetActor(() => slot.current, sockets),
          waitUntil: noPin,
          dispatch: "proxy",
        }),
      };
      await vars.core.instance;
      return vars;
    },
    onWebSocket: (c, websocket: RawWebSocket) => {
      const { core, sockets } = varsOf(c);
      // Rivet delivers an already-accepted socket. Register it so
      // `getWebSockets` sees it even if the user never calls
      // `acceptWebSocket` (workerd requires that call; here it only adds
      // tags), then bridge events onto the portable handlers.
      if (!sockets.has(websocket)) {
        sockets.set(websocket, []);
      }
      const socket = fromWebSocket(websocket);
      websocket.addEventListener?.("message", (event: { data?: unknown }) => {
        void core.execute(
          (instance) =>
            instance.webSocketMessage?.(
              socket,
              event.data as string | ArrayBuffer,
            ) ?? Effect.void,
        );
      });
      websocket.addEventListener?.(
        "close",
        (event: { code?: number; reason?: string; wasClean?: boolean }) => {
          sockets.delete(websocket);
          void core.execute(
            (instance) =>
              instance.webSocketClose?.(
                socket,
                event.code ?? 1000,
                event.reason ?? "",
                event.wasClean ?? true,
              ) ?? Effect.void,
          );
        },
      );
    },
    actions: {
      ...Object.fromEntries(
        methods.map((method) => [
          method,
          (c: RivetActorContext, ...args: unknown[]) =>
            varsOf(c).core.execute((instance) => {
              const member = instance[method];
              return collectingStreams(
                typeof member === "function" ? member(...args) : member,
              );
            }, handleRpcExit),
        ]),
      ),
      // Reserved: delivers `storage.setAlarm`. Generation-guarded because
      // Rivet's scheduler has no cancel (see DurableObject.ts).
      [ALARM_ACTION]: (c: RivetActorContext, generation: number) => {
        const { core } = varsOf(c);
        if (!isAlarmCurrent(c.state, generation)) {
          return;
        }
        consumeAlarm(c.state);
        return core.execute(
          (instance) => instance.alarm?.(undefined) ?? Effect.void,
        );
      },
    },
  });
};
