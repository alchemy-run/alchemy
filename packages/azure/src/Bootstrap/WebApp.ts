/**
 * Process entry for an Effect-native `Azure.Web.WebApp`. The generated entry
 * imports this module and the user's `main`, nothing else, and awaits
 * {@link bootstrap} at the top level (see `alchemy/Runtime/Bootstrap`).
 *
 * App Service starts the bundle with `node index.mjs` and passes the port to
 * listen on in `PORT`. Credentials come from the app's system-assigned
 * managed identity (`IDENTITY_ENDPOINT` + `IDENTITY_HEADER`), so bindings
 * call Azure with exactly the roles the deploy granted.
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

/**
 * Resolve the bundled program (the `fetch` handler and any `host.run`
 * loops) and run it with a Node HTTP server bound to `PORT`.
 */
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

  return runProcess("Azure web app", program);
};
