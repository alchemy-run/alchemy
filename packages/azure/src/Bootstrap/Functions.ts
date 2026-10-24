/**
 * Process bootstrap for `Azure.Functions.Function`: a Node process running
 * as an Azure Functions custom handler. The Functions host forwards HTTP
 * requests (and POSTs non-HTTP trigger invocations to `/{functionName}`) to
 * the port it passes in `FUNCTIONS_CUSTOMHANDLER_PORT`. The generated entry
 * imports this module and the user's `main`, nothing else — see
 * {@link ./Process.ts} for why.
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
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/** Serve the bundled program on the custom-handler port. */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const port = process.env.FUNCTIONS_CUSTOMHANDLER_PORT;
  if (port !== undefined) process.env.PORT = port;

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(NodeHttpServer({ hostname: "127.0.0.1" })),
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

  return runProcess("Azure Functions custom handler", program);
};
