import type { DurableObject } from "cloudflare:workers";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { DurableObjectExport } from "../Workers/DurableObject.ts";
import { makeDurableObjectBridge } from "../Workers/Workerd/DurableObjectBridge.ts";
import {
  DurableObjectState,
  fromDurableObjectState,
} from "./DurableObjectState.ts";
import { getCelldWorkerExport } from "./WorkerBridge.ts";
import { makeDurableObjectCallbackFactory } from "./AlarmCallback.ts";

export const makeCelldDurableObjectBridge = (
  DurableObjectClass: typeof DurableObject,
  entrypoint: Effect.Effect<Record<string, any>> | Layer.Layer<any, any, any>,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
) => {
  const bridge = makeDurableObjectBridge(DurableObjectClass, {
    makeCallback: makeDurableObjectCallbackFactory,
    getExport: (exportName) =>
      getCelldWorkerExport<DurableObjectExport>({
        entrypoint,
        stack: options.stack,
        exportName,
      }),
    services: (state) =>
      Context.make(DurableObjectState, fromDurableObjectState(state)),
  });
  return (className: string) => bridge(className, { dispatch: "static" });
};
