/**
 * Bootstrap for Celld **fleet** Worker bundles. The generated entry is a
 * thin shim importing only `cloudflare:workers` (runtime-provided),
 * `alchemy/Runtime/Bootstrap/CelldFleet`, and the user's `main` — see
 * {@link ./Process.ts} for why the wiring lives in a real module instead of
 * an inline template string. The bridges themselves live in `Celld/`.
 */
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { makeCelldDurableObjectBridge } from "../../Celld/DurableObjectBridge.ts";
import { makeCelldWorkerBridge } from "../../Celld/WorkerBridge.ts";
import {
  makeWorkflowBridge,
  type WorkflowEntrypointClass,
} from "../../Celld/Workflows/WorkflowBridge.ts";

export const makeFleetBootstrap = (
  base: {
    /** `DurableObject` from `cloudflare:workers`. */
    readonly DurableObject: typeof DurableObject;
    /** `WorkerEntrypoint` from `cloudflare:workers`. */
    readonly WorkerEntrypoint: typeof WorkerEntrypoint;
    /** Present when the generated bundle exports native Workflow classes. */
    readonly WorkflowEntrypoint?: WorkflowEntrypointClass;
  },
  entrypoint: Effect.Effect<Record<string, any>> | Layer.Layer<any, any, any>,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
) => ({
  /** The object-form main worker celld's loader requires. */
  default: makeCelldWorkerBridge(base.WorkerEntrypoint, entrypoint, options),
  /** Native workflows are distinct from Durable Objects in both metadata and exports. */
  workflow: (className: string) => {
    if (!base.WorkflowEntrypoint)
      throw new Error("Celld WorkflowEntrypoint is unavailable");
    return makeWorkflowBridge(base.WorkflowEntrypoint, {
      entrypoint,
      ...options,
    })(className);
  },
  /** The exported bridge class for one hosted Durable Object class. */
  durableObject: makeCelldDurableObjectBridge(
    base.DurableObject,
    entrypoint,
    options,
  ),
});
