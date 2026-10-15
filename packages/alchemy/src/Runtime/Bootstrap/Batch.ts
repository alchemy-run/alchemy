/**
 * Process bootstrap for `AWS.Batch.JobDefinition` containers. The generated
 * entry imports this module and the user's `main`, nothing else — see
 * {@link ./Process.ts} for why.
 */
/* oxlint-disable alchemy/package-boundaries -- package split phase 3: per-cloud runtime bootstrap; moves into its provider */
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Region from "@distilled.cloud/aws/Region";
/* oxlint-enable alchemy/package-boundaries */
import { BunServices } from "@effect/platform-bun";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { entrypointLayer, resolveProgram, runProcess, stackFromEnv } from "./Process.ts";

/**
 * Run the bundled job to completion: no HTTP server, and the process exits 0
 * explicitly once the program finishes (Batch waits on the container).
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(Credentials.fromEnv()),
        Layer.provideMerge(Region.fromEnv()),
        Layer.provideMerge(platform),
        Layer.provideMerge(Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv())),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Batch job", program, { exitOnComplete: true });
};
