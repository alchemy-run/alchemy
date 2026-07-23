/**
 * Runtime entry for {@link Service} — executed by `bun` inside the
 * detached process. Nothing is bundled: this script dynamic-imports the
 * user's `main` module (Bun runs TypeScript directly), resolves the
 * declared handler (the Effectful Constructor), and runs its program —
 * `host.run` loops and a Bun HTTP server bound to `PORT` serving the
 * returned `fetch`.
 *
 * The declaring module runs under `ALCHEMY_PHASE=runtime`, so the
 * Platform constructor takes its runtime branch (no providers, no
 * plan) and yields the instance whose `RuntimeContext.exports` carries
 * the program.
 *
 * Startup handshake: the reconciler passes `ALCHEMY_SERVICE_READY_FILE`
 * and waits for it. When the program serves HTTP, the file is written
 * the moment the server BINDS — carrying the OBSERVED port (the
 * kernel-assigned one when `PORT=0` asked for an ephemeral port).
 * Programs with no HTTP surface report ready as soon as the program is
 * resolved. Either way the reconciler learns "the process came up" and
 * (when applicable) which port it serves on.
 */
import { BunServices } from "@effect/platform-bun";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { BunHttpServer } from "../Http.ts";
import { reifyBoundConfigProvider } from "../Runtime.ts";
import { Stack } from "../Stack.ts";

const mainPath = process.env.ALCHEMY_SERVICE_MAIN;
if (!mainPath) {
  throw new Error("Server.Service entry: ALCHEMY_SERVICE_MAIN is not set");
}
const handlerName = process.env.ALCHEMY_SERVICE_HANDLER ?? "default";
const readyFile = process.env.ALCHEMY_SERVICE_READY_FILE;

const module_ = await import(mainPath);
const handler = module_[handlerName] as Effect.Effect<{
  RuntimeContext: {
    exports: Effect.Effect<{
      program: Effect.Effect<void, never, any>;
      serves: boolean;
    }>;
  };
}>;
if (handler === undefined) {
  throw new Error(
    `Server.Service entry: '${mainPath}' has no export named '${handlerName}'`,
  );
}

/** Report startup to the reconciler: atomic write, rename into place. */
const reportReady = (report: { pid: number; port?: number }) =>
  Effect.promise(async () => {
    if (!readyFile) return;
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${readyFile}.tmp`, JSON.stringify(report));
    await fs.rename(`${readyFile}.tmp`, readyFile);
  });

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the program (the runners registered via host.run / serve) and
// run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is actually served and host.run loops stay alive. The server
// reports its BOUND address into the ready file as it starts listening.
const program = handler.pipe(
  Effect.flatMap((instance) => instance.RuntimeContext.exports),
  Effect.flatMap((exports) =>
    exports.serves
      ? exports.program
      : // no HTTP surface: the process is "up" once the program starts
        Effect.andThen(reportReady({ pid: process.pid }), exports.program),
  ),
  Effect.provide(
    Layer.effect(
      Stack,
      Effect.all([
        Config.string("ALCHEMY_STACK_NAME"),
        Config.string("ALCHEMY_STAGE"),
      ]).pipe(
        Effect.map(([name, stage]) => ({
          name,
          stage,
          bindings: {},
          resources: {},
          actions: {},
        })),
      ),
    ).pipe(
      Layer.provideMerge(
        BunHttpServer({
          onListen: (address) =>
            reportReady({ pid: process.pid, port: address.port }),
        }),
      ),
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

console.log(`Server.Service starting (${mainPath})...`);
await Effect.runPromise(program as Effect.Effect<void>).catch((error) => {
  console.error("Server.Service failed:", error);
  process.exit(1);
});
