/**
 * Process entry for an Effect program on `Azure.ContainerInstance.ContainerGroup`
 * (a Node.js process in the group's `app` container). The generated entry
 * imports this module and the user's `main`, nothing else — see
 * `alchemy/Runtime/Bootstrap` for why.
 *
 * It runs the program's runners (`fetch` on a Node HTTP server bound to
 * `PORT`, and `run`) for the life of the container. Credentials come from
 * the group's system-assigned managed identity.
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

/** Resolve the bundled program and run it until the container stops. */
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
        Layer.provideMerge(NodeHttpServer({ hostname: "0.0.0.0" })),
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

  return runProcess("Azure container group", program);
};
