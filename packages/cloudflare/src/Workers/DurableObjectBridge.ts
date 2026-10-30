import type { DurableObjectExport } from "alchemy/Workers/DurableObject";
import { makeDurableObjectBridge as makeWorkerdBridge } from "alchemy/Workers/Workerd/DurableObjectBridge";
import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import { makeDurableObjectCallbackFactory } from "./AlarmCallback.ts";
import {
  BackgroundWork,
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
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
    services: (state) =>
      Context.make(DurableObjectState, fromDurableObjectState(state)) as Context.Context<never>,
    callServices: (_, track) => Context.make(BackgroundWork, track) as Context.Context<never>,
  });
  return (className: string) => bridge(className);
};
