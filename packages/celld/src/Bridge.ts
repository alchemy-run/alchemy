/**
 * Bootstrap for Celld **fleet** Worker bundles. The generated entry is a
 * thin shim importing only `cloudflare:workers` (runtime-provided), this
 * module, and the user's `main`, so the bundle never resolves alchemy's own
 * dependencies from the consumer's project. The bridges themselves live in
 * the sibling modules.
 */
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import { makeCelldDurableObjectBridge } from "./DurableObjectBridge.ts";
import { makeCelldWorkerBridge } from "./WorkerBridge.ts";
import { makeWorkflowBridge, type WorkflowEntrypointClass } from "./Workflows/WorkflowBridge.ts";

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
    if (!base.WorkflowEntrypoint) throw new Error("Celld WorkflowEntrypoint is unavailable");
    return makeWorkflowBridge(base.WorkflowEntrypoint, {
      entrypoint,
      ...options,
    })(className);
  },
  /** The exported bridge class for one hosted Durable Object class. */
  durableObject: makeCelldDurableObjectBridge(base.DurableObject, entrypoint, options),
});

export { withSqlMigrations } from "@alchemy.run/sql/Migrations/EmbeddedEntrypoint";
