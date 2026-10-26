import * as Shared from "alchemy/Workers/Workerd/Bundle";
import type { WorkerBuildOptions } from "alchemy/Workers/Workerd/Bundle";
import * as Effect from "effect/Effect";
import { DeploymentError } from "./Deployment/Objects.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";

/** Celld cannot reliably link Rolldown's split Effect dependency graph. */
export const workerBuildOptions = (
  options?: WorkerBuildOptions,
): Effect.Effect<WorkerBuildOptions, DeploymentError> =>
  Effect.gen(function* () {
    if (options?.output?.codeSplitting !== undefined && options.output.codeSplitting !== false) {
      return yield* Effect.fail(
        new DeploymentError({
          reason: "unsupported",
          message:
            "Celld requires a single JavaScript bundle; build.output.codeSplitting must be false.",
        }),
      );
    }
    return {
      ...options,
      output: { ...options?.output, codeSplitting: false as const },
    };
  });

/** The bundle options of a Celld Worker: its entry and its exported classes. */
export interface CelldWorkerBundleOptions extends Omit<Shared.WorkerBundleOptions, "entry"> {
  entry: { kind: "external" } | { kind: "effect"; exports: Record<string, unknown> };
}

/** The workerd bundler configured with Celld's generated fleet entry. */
export const CelldWorkerBundle = Shared.makeWorkerBundle<CelldWorkerBundleOptions>({
  // Celld runs Workers-compatible bundles; it shares workerd's node
  // compatibility plugins with Cloudflare.
  loadCompatPlugins: () =>
    import("@alchemy.run/cloudflare-runtime/rolldown").then((module) => module.default),
  virtualEntry: (options) =>
    options.entry.kind === "effect"
      ? makeCelldVirtualEntry(options.entry.exports, options.stack)
      : undefined,
});
