/**
 * Process bootstrap for a `Boat.Sandbox` with `main` (a Node process in
 * the sandbox serving the bundled program). The generated entry imports this module
 * and the user's `main`, nothing else — see `alchemy/Runtime/Bootstrap`
 * for why.
 */
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
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/**
 * Resolve the bundled program (the runners registered via `host.run` /
 * serve) and run it with a Node HTTP server bound to `PORT` on every
 * interface, so the sandbox's port URL reaches the `{ fetch }`
 * handler and `host.run` loops stay alive.
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    SecureRandom.layerWebCrypto,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
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

  return runProcess("Boat program", program);
};
