import type { DurableObject as DurableObjectClass } from "cloudflare:workers";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { DurableObjectExport } from "../../Workers/DurableObject.ts";
import { makeDurableObjectBridge as makeWorkerdDurableObjectBridge } from "../../Workers/Workerd/DurableObjectBridge.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { getWorkerExport } from "./WorkerBridge.ts";

export type { DurableObjectBridgeOptions } from "../../Workers/Workerd/DurableObjectBridge.ts";

export const makeDurableObjectBridge = (
  DurableObject: typeof DurableObjectClass,
  options: {
    entrypoint: Effect.Effect<Record<string, any>>;
    stack: { name: string; stage: string };
  },
) =>
  makeWorkerdDurableObjectBridge(DurableObject, {
    getExport: (exportName) =>
      getWorkerExport<DurableObjectExport>({ ...options, exportName }),
    services: (state) =>
      Context.make(DurableObjectState, fromDurableObjectState(state)),
  });
