import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { RpcActivationScope } from "../RpcDurableObject.ts";
import type { CallbackFactory } from "../../Callback.ts";
import {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
} from "./AlarmCallback.ts";
import { makeRequestEffect } from "../../Cloudflare/Workers/HttpServer.ts";
import type { DurableObjectExport } from "../DurableObject.ts";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "../DurableObjectBridge.ts";
import type { Pin, WorkerBuild } from "../Worker.ts";
import { fromWebSocket } from "./WebSocket.ts";

export interface DurableObjectBridgeOptions {
  readonly dispatch?: "proxy" | "static";
}

export interface WorkerdDurableObjectBridgeOptions {
  readonly makeCallback: (state: cf.DurableObjectState) => CallbackFactory;
  readonly getExport: (className: string) => {
    readonly build: (pin: Pin) => Promise<WorkerBuild<DurableObjectExport>>;
  };
  readonly services: (
    state: cf.DurableObjectState,
    env: Record<string, unknown>,
  ) => Context.Context<any>;
}

export const makeDurableObjectBridge =
  (
    DurableObject: typeof DurableObjectClass,
    adapter: WorkerdDurableObjectBridgeOptions,
  ) =>
  (className: string, options?: DurableObjectBridgeOptions) => {
    const { build } = adapter.getExport(className);
    const dispatch = options?.dispatch ?? "proxy";

    return class DurableObjectBridge extends DurableObject {
      readonly #core: DurableObjectInstance;
      readonly #state: cf.DurableObjectState;

      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;
        const makeCallback = adapter.makeCallback(state);
        // Native eviction has no JavaScript teardown hook; requests own I/O cleanup.
        const activationScope = Scope.makeUnsafe();
        this.#core = makeDurableObjectInstance({
          build,
          runtimeContext: (runtime) => ({ ...runtime, makeCallback }),
          initialize: () => initializeAlarmCallbacks(state),
          services: Context.add(
            adapter.services(state, env),
            RpcActivationScope,
            activationScope,
          ),
          waitUntil: (promise) => state.waitUntil(promise),
          dispatch,
          target: this,
          // Init I/O requires the native constructor's concurrency gate.
          gate: (run) =>
            state.blockConcurrencyWhile(() =>
              run().catch(async (error) => {
                await Effect.runPromise(
                  Scope.close(activationScope, Exit.fail(error)),
                );
                throw error;
              }),
            ),
        });
        void this.#core.instance.catch(() => {});
        if (dispatch === "static") return this;

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (member: any) =>
              typeof member === "function" ? member.bind(target) : member;
            if (typeof prop !== "string" || prop in target)
              return bind((target as any)[prop]);
            return this.#core.dispatch(prop);
          },
        });
      }

      async fetch(request: Request): Promise<any> {
        return this.#core.execute((instance) =>
          makeRequestEffect(
            request as any,
            this.#core.fetch(instance, request),
          ),
        );
      }

      async alarm(info?: cf.AlarmInvocationInfo): Promise<void> {
        await this.#core.execute((instance) => {
          const state = this.#state;
          return Effect.gen(function* () {
            yield* dispatchAlarmCallbacks(state, instance.alarm !== undefined);
            yield* instance.alarm?.(info) ?? Effect.void;
          });
        });
      }

      async webSocketMessage(
        ws: WebSocket,
        message: string | ArrayBuffer,
      ): Promise<void> {
        await this.#core.execute(
          (instance) =>
            instance.webSocketMessage?.(fromWebSocket(ws as any), message) ??
            Effect.void,
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
            instance.webSocketClose?.(
              fromWebSocket(ws as any),
              code,
              reason,
              wasClean,
            ) ?? Effect.void,
        );
      }

      async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
        await this.#core.execute(
          (instance) =>
            instance.webSocketError?.(fromWebSocket(ws as any), error) ??
            Effect.void,
        );
      }
    } as any;
  };
