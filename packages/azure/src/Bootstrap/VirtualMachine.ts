/**
 * Process entry for an Effect-native `Azure.Compute.VirtualMachine` program
 * (a systemd unit running Node.js). The generated entry imports this module,
 * calls {@link loadEnv}, then imports the user's `main` and awaits
 * {@link bootstrap}.
 *
 * The program's `fetch` is served by a Node HTTP server on `PORT` (all
 * interfaces), and `host.run` loops run for the life of the process.
 * Credentials come from the VM's system-assigned managed identity (IMDS).
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

export { loadEnv } from "./VirtualMachineCore.ts";

/** Run the bundled program with a Node HTTP server on the VM's `PORT`. */
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

  return runProcess("Azure virtual machine program", program);
};
