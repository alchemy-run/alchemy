/**
 * Process entry for an Effect-native `Azure.ContainerApps.ContainerApp`. The
 * generated entry imports this module and the user's `main`, nothing else
 * (see `alchemy/Runtime/Bootstrap` for why), and awaits {@link bootstrap}.
 *
 * It runs the program's init, then serves its `fetch` with Node's HTTP
 * server on `PORT` and keeps every `run` loop (event-source consumers,
 * schedules) alive for the replica's lifetime. Credentials come from the
 * app's managed identity (`IDENTITY_ENDPOINT`).
 */
import { fromManagedIdentity } from "@distilled.cloud/azure/Credentials";
import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
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

/** Resolve the bundled program and run it until the replica stops. */
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
        Layer.provideMerge(NodeHttpServer({ hostname: "0.0.0.0" })),
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

  return runProcess("Azure Container App", program);
};
