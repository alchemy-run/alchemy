import type * as cf from "@cloudflare/workers-types";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import {
  fromDurableObjectState,
  type DurableObjectExport,
} from "../../Workers/DurableObject.ts";
import {
  makeDurableObjectInstance,
  type DurableObjectInstance,
} from "../../Workers/DurableObjectBridge.ts";
import { fromWebSocket } from "../../Workers/WebSocket.ts";
import { makeRequestEffect } from "./HttpServer.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

export interface DurableObjectBridgeOptions {
  /**
   * How RPC methods reach the instance — see
   * `Workers/DurableObjectBridge.ts`. Workerd's JSRPC dispatches through
   * the bridge's `Proxy`; an engine whose RPC stalls on Proxy-returning
   * constructors selects `"static"` to get real instance methods and the
   * fetch-RPC protocol on `fetch`.
   *
   * @default "proxy"
   */
  readonly dispatch?: "proxy" | "static" | undefined;
}

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 *
 * Accepts the `DurableObject` base class so the implementation lives in
 * real TypeScript instead of a generated string template.
 */
export const makeDurableObjectBridge =
  (
    DurableObject: typeof DurableObjectClass,
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: {
        name: string;
        stage: string;
      };
    },
  ) =>
  (className: string, options?: DurableObjectBridgeOptions) => {
    // One isolate-lifetime layer build shared by every activation of this DO
    // class: `build` memoizes the built context, so re-activations (including
    // hibernatable WebSocket wakes, which re-run the constructor) reuse it
    // instead of rebuilding the layer stack.
    const { build } = getWorkerExport<DurableObjectExport>({
      entrypoint,
      stack,
      exportName: className,
    });
    const dispatch = options?.dispatch ?? "proxy";

    return class DurableObjectBridge extends DurableObject {
      readonly #core: DurableObjectInstance;
      constructor(state: cf.DurableObjectState, env: any) {
        super(state as any, env);

        this.#core = makeDurableObjectInstance({
          build,
          state: fromDurableObjectState(state),
          waitUntil: (promise) => void state.waitUntil?.(promise),
          dispatch,
          target: this,
          // The whole build — including any I/O the init performs — runs
          // inside workerd's concurrency gate: a DO constructor has no I/O
          // context outside it, and event delivery waits for the build.
          gate: (run) => state.blockConcurrencyWhile(run),
        });
        // A failed build surfaces through `#core.instance` on every call;
        // observe it here so it does not also report as unhandled.
        void this.#core.instance.catch(() => {});

        if (dispatch === "static") {
          return this;
        }

        return new Proxy(this, {
          get: (target, prop) => {
            const bind = (f: any) =>
              typeof f === "function" ? f.bind(target) : f;
            if (typeof prop !== "string") return bind((target as any)[prop]);
            if (prop in target) return bind((target as any)[prop]);
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

      async alarm(alarmInfo?: cf.AlarmInvocationInfo): Promise<void> {
        await this.#core.execute((instance) => instance.alarm!(alarmInfo));
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
    } as any;
  };
