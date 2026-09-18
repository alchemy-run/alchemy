import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { DurableObjectExport } from "../../Workers/DurableObject.ts";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "../../Workers/DurableObjectBridge.ts";
import type { DurableObjectBridgeOptions } from "../../Workers/Workerd/DurableObjectBridge.ts";
import {
  dispatchAlarmCallbacks,
  initializeAlarmCallbacks,
  makeDurableObjectCallbackFactory,
} from "./AlarmCallback.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import { fromWebSocket } from "./WebSocket.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

export type { DurableObjectBridgeOptions } from "../../Workers/Workerd/DurableObjectBridge.ts";

export const makeDurableObjectBridge =
  (
    DurableObject: typeof DurableObjectClass,
    options: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: { name: string; stage: string };
    },
  ) =>
  (className: string, bridgeOptions?: DurableObjectBridgeOptions) => {
    const { build } = getWorkerExport<DurableObjectExport>({
      ...options,
      exportName: className,
    });
    const dispatch = bridgeOptions?.dispatch ?? "proxy";

    return class DurableObjectBridge extends DurableObject {
      readonly #core: DurableObjectInstance;
      readonly #state: cf.DurableObjectState;

      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);
        this.#state = state;
        this.#core = makeDurableObjectInstance({
          build: (pin) =>
            build(pin).then((built) => {
              const { runtimeContext } = built;
              const instanceRuntimeContext = {
                ...runtimeContext,
                makeCallback: makeDurableObjectCallbackFactory(state),
              };
              return {
                ...built,
                export: {
                  ...built.export,
                  services: Context.add(
                    built.export.services,
                    RuntimeContext,
                    instanceRuntimeContext,
                  ),
                  constructor: built.export.constructor.pipe(
                    // Callback registration belongs to the inner, per-instance Effect.
                    Effect.provide(
                      Layer.succeed(RuntimeContext, runtimeContext),
                    ),
                    Effect.map((instance) =>
                      Effect.suspend(() => {
                        const seal = initializeAlarmCallbacks(state);
                        return instance.pipe(
                          Effect.ensuring(Effect.sync(seal)),
                        );
                      }),
                    ),
                  ),
                },
              };
            }),
          services: Context.make(
            DurableObjectState,
            fromDurableObjectState(state),
          ),
          waitUntil: (promise) => state.waitUntil(promise),
          dispatch,
          target: this,
          gate: (run) => state.blockConcurrencyWhile(run),
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
        await this.#core.execute((instance) =>
          dispatchAlarmCallbacks(
            this.#state,
            instance.alarm !== undefined,
          ).pipe(Effect.andThen(() => instance.alarm?.(info) ?? Effect.void)),
        );
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
