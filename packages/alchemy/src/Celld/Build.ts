import * as Effect from "effect/Effect";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { DeploymentError } from "./Deployment/Objects.ts";

/** Celld v0.5 cannot reliably link Rolldown's split Effect dependency graph. */
export const workerBuildOptions = (
  options?: WorkerBuildOptions,
): Effect.Effect<WorkerBuildOptions, DeploymentError> =>
  Effect.gen(function* () {
    if (
      options?.output?.codeSplitting !== undefined &&
      options.output.codeSplitting !== false
    ) {
      return yield* Effect.fail(
        new DeploymentError({
          reason: "unsupported",
          message:
            "Celld v0.5 requires a single JavaScript bundle; build.output.codeSplitting must be false.",
        }),
      );
    }
    return {
      ...options,
      output: { ...options?.output, codeSplitting: false as const },
    };
  });
