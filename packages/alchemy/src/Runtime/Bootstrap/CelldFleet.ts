/**
 * Bootstrap for Celld **fleet** Worker bundles. The generated entry is a
 * thin shim importing only `cloudflare:workers` (runtime-provided),
 * `alchemy/Runtime/Bootstrap/CelldFleet`, and the user's `main` — see
 * {@link ./Process.ts} for why the wiring lives in a real module instead of
 * an inline template string. The bridges themselves live in `Celld/`.
 */
import type { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type * as Effect from "effect/Effect";
import { makeCelldDurableObjectBridge } from "../../Celld/DurableObjectBridge.ts";
import { makeCelldWorkerBridge } from "../../Celld/WorkerBridge.ts";

export const makeFleetBootstrap = (
  base: {
    /** `DurableObject` from `cloudflare:workers`. */
    readonly DurableObject: typeof DurableObject;
    /** `WorkerEntrypoint` from `cloudflare:workers`. */
    readonly WorkerEntrypoint: typeof WorkerEntrypoint;
  },
  entrypoint: Effect.Effect<Record<string, any>>,
  options: {
    readonly stack: { readonly name: string; readonly stage: string };
  },
) => ({
  /** The object-form main worker celld's loader requires. */
  default: makeCelldWorkerBridge(base.WorkerEntrypoint, entrypoint, options),
  /** The exported bridge class for one hosted Durable Object class. */
  durableObject: makeCelldDurableObjectBridge(
    base.DurableObject,
    entrypoint,
    options,
  ),
});
