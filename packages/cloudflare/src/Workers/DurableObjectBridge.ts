import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import { makeDurableObjectBridge as makeWorkerdBridge } from "alchemy/Workers/Workerd/DurableObjectBridge";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import { makeDurableObjectCallbackFactory } from "./AlarmCallback.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
  type NativeDurableObjectState,
} from "./DurableObjectState.ts";
import { takeRpcTraceContext } from "./internal/RpcTraceContext.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

/**
 * Create a DurableObjectBridge class that proxies RPC method calls through
 * the Effect runtime, encoding success/fail/stream results as RPC envelopes.
 */
export const makeDurableObjectBridge = (
  DurableObject: typeof DurableObjectClass,
  options: {
    entrypoint: Effect.Effect<Record<string, any>>;
    stack: { name: string; stage: string };
  },
) => {
  const bridge = makeWorkerdBridge(DurableObject, {
    makeCallback: makeDurableObjectCallbackFactory,
    getExport: (exportName) => getWorkerExport<DurableObjectExport>({ ...options, exportName }),
    // The native state workerd constructed the object with. `unknown` skips
    // comparing its two declarations, which hangs (see `NativeDurableObjectState`).
    services: (state) =>
      Context.make(
        DurableObjectState,
        fromDurableObjectState(state as unknown as NativeDurableObjectState),
      ) as Context.Context<never>,
    // A stub appends the caller's trace context; one from an older deploy
    // doesn't, and its call starts a trace of its own.
    rpcArgs: takeRpcTraceContext,
  });
  return (className: string) => bridge(className);
};
