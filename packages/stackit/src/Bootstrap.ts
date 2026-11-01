/**
 * Process bootstrap for an effectful `Stackit.Functions.Function`,
 * `Stackit.ContainerApplications.Application`, `Stackit.CloudFoundry.App` or
 * `Stackit.IaaS.Service` (a bun process serving the bundled program). The generated entry
 * imports this module and the user's `main`, nothing else: see `alchemy/Runtime/Bootstrap` for why.
 */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { reifyBoundConfigProvider } from "alchemy/Runtime";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import { ManagedHttpShutdown } from "alchemy/Runtime/ManagedHttpShutdown";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

/**
 * Below the shortest stop window of the platforms that run this: Cloud Foundry's 10 seconds, and
 * systemd's 90 on a `Stackit.IaaS.Service`. Kept here, not imported from `internal/serverHost`,
 * so the bundled program doesn't take in that deploy-time module.
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Resolve the bundled program and run it with a Bun HTTP server bound to `PORT`,
 * so the returned `{ fetch }` handler is served. The image sets `PORT` to the
 * runtime's port, and a value the platform injects takes precedence over it.
 *
 * A stop signal closes the program's scopes: background runners are interrupted with their
 * finalizers, and the HTTP server stops once it has answered what it was serving. A runner mid
 * message is interrupted too, so a consumer's handler has to tolerate the redelivery.
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const services = entrypointLayer(entrypoint).pipe(
    Layer.provideMerge(stackFromEnv),
    Layer.provideMerge(BunHttpServer({ hostname: "0.0.0.0" })),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
      ),
    ),
  );

  const program = Effect.gen(function* () {
    const managed = yield* Effect.serviceOption(ManagedHttpShutdown);
    if (Option.isNone(managed)) {
      return yield* resolveProgram("program").pipe(Effect.provide(services), Effect.scoped);
    }
    // Initializer dependencies outlive both run finalizers and HTTP responses.
    const context = yield* Layer.buildWithScope(services, managed.value.dependencies);
    return yield* resolveProgram("program").pipe(
      Effect.provideContext(context),
      Scope.provide(managed.value.dependencies),
    );
  });

  return runProcess("STACKIT host", program, {
    managedHttpShutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS,
  });
};
