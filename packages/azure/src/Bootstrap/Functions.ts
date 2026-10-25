/**
 * Process entry for an Effect-native `Azure.Functions.Function` or
 * `Azure.Web.FunctionApp`. The generated entry imports this module and the
 * user's `main`, nothing else, and awaits {@link bootstrap} at the top level.
 *
 * The Functions Node.js worker loads the entry file and then locks its
 * function index, so `bootstrap` resolves only after the program's init has
 * run: by then `fetch` and every event source have registered with the
 * runtime registry, and each entry becomes one Functions function (see
 * `./FunctionsCore.ts`). The program's scope stays open for the instance's
 * lifetime. Credentials come from the app's managed identity.
 */
import { fromManagedIdentity } from "@distilled.cloud/azure/Credentials";
import { NodeServices } from "@effect/platform-node";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import { entrypointLayer, stackFromEnv } from "alchemy/Runtime/Bootstrap";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { functionRegistry } from "../Functions/internal.ts";
import { registerHttpFunction, registerTriggerFunction } from "./FunctionsCore.ts";

/** Run the program's init, then register its functions with the worker. */
export const bootstrap = async (entrypoint: unknown): Promise<void> => {
  const initialized = Deferred.makeUnsafe<void>();
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );
  const program = Deferred.succeed(initialized, undefined).pipe(
    Effect.andThen(Effect.never),
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
  Effect.runFork(
    program.pipe(
      Effect.tapCause((cause) => Effect.logError("Azure Functions program failed", cause)),
      Effect.onExit(() =>
        Deferred.die(initialized, new Error("Azure Functions program exited during init")),
      ),
    ),
  );
  await Effect.runPromise(Deferred.await(initialized));

  const registry = functionRegistry();
  if (registry.http !== undefined) {
    registerHttpFunction("http", registry.http);
  }
  for (const [name, trigger] of registry.triggers) {
    registerTriggerFunction(name, trigger.binding, trigger.run);
  }
};
