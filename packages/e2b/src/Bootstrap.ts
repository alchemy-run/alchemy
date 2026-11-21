/**
 * Process bootstrap for `E2B.Template` programs (a Bun process serving the
 * bundled program). The generated entry imports this module and the user's
 * `main`, nothing else — see `alchemy/Runtime/Bootstrap` for why.
 */
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { TerminalsBun } from "alchemy/Runtime/TerminalBun";
import { RuntimeConfigProviderLive } from "alchemy/Runtime";
import {
  entrypointLayer,
  resolveProgram,
  runProcess,
  stackFromEnv,
} from "alchemy/Runtime/Bootstrap";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

/**
 * Resolve the bundled program (the runners registered via `host.run` /
 * serve) and run it with a Bun HTTP server bound to `PORT`, so the returned
 * `{ fetch }` handler is actually served and `host.run` loops stay alive.
 */
export const bootstrap = (entrypoint: unknown): Promise<void> => {
  const platform = Layer.mergeAll(
    BunServices.layer,
    TerminalsBun,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const program = resolveProgram("program").pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(BunHttpServer()),
        Layer.provideMerge(platform),
        Layer.provideMerge(RuntimeConfigProviderLive),
      ),
    ),
    Effect.scoped,
  );

  return runProcess("Docker service", program);
};
