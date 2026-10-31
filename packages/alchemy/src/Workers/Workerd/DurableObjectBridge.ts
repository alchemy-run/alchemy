/**
 * The workerd flavor of the Durable Object bridge, shared by every engine
 * whose objects follow the Workers API (Cloudflare today): the exported
 * `DurableObject` subclass that turns workerd's lifecycle and JSRPC calls
 * into Effect calls on the engine-invariant instance core.
 *
 * @internal
 */
import type * as cf from "@cloudflare/workers-types";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Tracer from "effect/Tracer";
import type { CallbackFactory } from "../../Callback.ts";
import type { DurableObjectExport } from "../DurableObject.ts";
import { makeDurableObjectInstance, type DurableObjectInstance } from "../DurableObjectBridge.ts";
import type { Pin, WorkerBuild } from "../Worker.ts";
import { dispatchAlarmCallbacks, initializeAlarmCallbacks } from "./AlarmCallback.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";

/** workerd's `DurableObject` base class. */
export type WorkerdDurableObjectClass = abstract new (state: any, env: any) => object;

export interface DurableObjectBridgeOptions {
  /**
   * How RPC reaches the instance. `"proxy"` (workerd) resolves methods
   * through the class's `Proxy`; `"static"` materializes them as real
   * methods and serves fetch-RPC over the object's own `fetch`. See
   * `DurableObjectInstanceOptions.dispatch`.
   * @default "proxy"
   */
  readonly dispatch?: "proxy" | "static";
}

export interface WorkerdDurableObjectBridgeOptions {
  /** The instance's durable callback factory. */
  readonly makeCallback: (state: cf.DurableObjectState) => CallbackFactory;
  /** Resolve a class export against the engine's shared build. */
  readonly getExport: (className: string) => {
    readonly build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport, any>>;
  };
  /** The engine's Durable Object state service for one instance. */
  readonly services: (
    state: cf.DurableObjectState,
    env: Record<string, unknown>,
  ) => Context.Context<never>;
  /** Per-call services built with the call's background-work hook. */
  readonly callServices?: (
    state: cf.DurableObjectState,
    track: (promise: Promise<unknown>) => void,
  ) => Context.Context<never>;
  /**
   * Split what the engine's stubs append to an RPC call's arguments (the
   * caller's trace context) off the arguments, returning the call's parent
   * span when there is one.
   */
  readonly rpcArgs?: (
    args: ReadonlyArray<unknown>,
  ) => readonly [args: ReadonlyArray<unknown>, parent: Option.Option<Tracer.AnySpan>];
}

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 */
export const makeDurableObjectBridge =
  (DurableObject: WorkerdDurableObjectClass, adapter: WorkerdDurableObjectBridgeOptions) =>
  (className: string, options?: DurableObjectBridgeOptions) => {
    // One isolate-lifetime layer build shared by every activation of this DO
    // class: `build` memoizes the built context, so re-activations (including
    // hibernatable WebSocket wakes, which re-run the constructor) reuse it
    // instead of rebuilding the layer stack.
    const { build } = adapter.getExport(className);
    const dispatch = options?.dispatch ?? "proxy";

    return class DurableObjectBridge extends DurableObject {
      readonly #core: DurableObjectInstance;
      readonly #state: cf.DurableObjectState;

      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;
        const makeCallback = adapter.makeCallback(state);
        this.#core = makeDurableObjectInstance({
          build,
          runtimeContext: (runtime) => ({ ...runtime, makeCallback }),
          initialize: () => initializeAlarmCallbacks(state),
          services: adapter.services(state, env),
          callServices: adapter.callServices
            ? (track) => adapter.callServices!(state, track)
            : undefined,
          waitUntil: (promise) => void (state as any).waitUntil?.(promise),
          dispatch,
          target: this,
          // Init I/O (a D1 `CREATE TABLE`, a migration) must run inside the
          // native constructor's concurrency gate, or it never completes.
          gate: (run) => state.blockConcurrencyWhile(run),
        });
        void this.#core.instance.catch(() => {});
        if (dispatch === "static") return this;

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (member: any) =>
              typeof member === "function" ? member.bind(target) : member;
            if (typeof prop !== "string" || prop in target) return bind((target as any)[prop]);
            if (adapter.rpcArgs === undefined) return this.#core.dispatch(prop);
            return (...callArgs: unknown[]) => {
              const [args, parent] = adapter.rpcArgs!(callArgs);
              return this.#core.dispatch(prop, Option.getOrUndefined(parent))(...args);
            };
          },
        });
      }

      async fetch(request: Request): Promise<any> {
        return this.#core.execute((instance) =>
          makeRequestEffect(request as any, this.#core.fetch(instance, request)),
        );
      }

      async alarm(alarmInfo?: cf.AlarmInvocationInfo): Promise<void> {
        const state = this.#state;
        await this.#core.execute((instance) =>
          dispatchAlarmCallbacks(state, instance.alarm !== undefined).pipe(
            Effect.andThen(() => instance.alarm?.(alarmInfo) ?? Effect.void),
          ),
        );
      }

      async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        await this.#core.execute(
          (instance) =>
            instance.webSocketMessage?.(fromWebSocket(ws as any), message) ?? Effect.void,
        );
      }

      async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean,
      ): Promise<void> {
        await this.#core.execute(
          (instance) =>
            instance.webSocketClose?.(fromWebSocket(ws as any), code, reason, wasClean) ??
            Effect.void,
        );
      }

      async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        await this.#core.execute(
          (instance) => instance.webSocketError?.(fromWebSocket(ws as any), error) ?? Effect.void,
        );
      }
    } as any;
  };
