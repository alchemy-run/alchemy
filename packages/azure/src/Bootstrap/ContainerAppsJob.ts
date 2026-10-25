/**
 * Process entry for an Effect-native `Azure.ContainerApps.Job`. The
 * generated entry imports this module and the user's `main`, nothing else,
 * and awaits {@link bootstrap} at the top level.
 *
 * No HTTP server: the program's init runs, then its `run` and every event
 * source's runner execute concurrently. The process exits 0 once they all
 * finish (Container Apps marks the replica succeeded) and 1 when one fails.
 * Credentials come from the job's managed identity.
 */
import { fromManagedIdentity } from "@distilled.cloud/azure/Credentials";
import { NodeServices } from "@effect/platform-node";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(fromManagedIdentity()),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Container Apps job", program, { exitOnComplete: true });
};
