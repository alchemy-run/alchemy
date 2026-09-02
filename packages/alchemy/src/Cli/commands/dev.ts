import * as Floci from "@alchemy.run/floci";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { fileURLToPath } from "node:url";
import { SPAWNER_URL_ENV_KEY } from "../../Dev/RpcProviderProxy.ts";
import * as RpcSpawner from "../../Dev/RpcSpawner.ts";
import {
  isRegisterHooksSupported,
  transformTypesFlags,
} from "../../Util/Node.ts";
import { DevOptions } from "../DevOptions.ts";
import {
  configPath,
  envFile,
  force,
  devStage,
  optionalConfig,
  profile,
  resolveStackArgs,
} from "./flags.ts";
import {
  installShutdownFeedback,
  suppressInterruptMessages,
} from "./errors.ts";

/**
 * Trust the Floci emulator CA in `alchemy dev` so cross-cloud data planes
 * terminated by the emulator's self-signed cert (e.g. an AWS Lambda MicroVM
 * bound to a local Cloudflare Worker) are reachable from local workerd. workerd
 * reads its trusted certificates from `NODE_EXTRA_CA_CERTS` at runtime init, so
 * this must be present in the env of every spawned child (the exec worker, the
 * RPC sidecar, and the workerd instances they start). `ensureFloci` refreshes
 * the bundle at this stable path (and sets the variable itself once written);
 * never clobber a value the caller set, and don't point at a missing file —
 * Node/Bun warn about it on every startup.
 */

export const devCommand = Command.make(
  "dev",
  {
    force,
    config: optionalConfig,
    configPath,
    envFile,
    stage: devStage,
    profile,
  },
  Effect.fn(
    function* (rawArgs) {
      const args = yield* resolveStackArgs("dev")(rawArgs);
      // This process is only the exec child's supervisor; the child owns the
      // terminal and announces the Ctrl+C shutdown. Without this, a SIGINT
      // hits both processes and the interrupt message prints twice.
      yield* suppressInterruptMessages;
      // Feedback stays silent here (suppressed — the exec child owns the
      // terminal); this install is for the force-quit on a second Ctrl+C.
      yield* installShutdownFeedback;
      const options = yield* Schema.encodeEffect(DevOptions)(args);
      const fs = yield* FileSystem.FileSystem;
      // Set on THIS process too, so the RPC spawner's sidecars (and the workerd
      // they launch) inherit it — they are forked from here, not from the exec
      // child below.
      if (yield* fs.exists(Floci.FLOCI_CA_PATH)) {
        process.env.NODE_EXTRA_CA_CERTS ??= Floci.FLOCI_CA_PATH;
      }
      const spawner = yield* RpcSpawner.RpcSpawner;
      // We no longer force Bun in development because this prevents us from testing in Node.
      const command =
        typeof globalThis.Bun !== "undefined"
          ? [
              "bun",
              "run",
              ...process.execArgv,
              "--watch",
              "--no-clear-screen",
              fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
            ]
          : import.meta.url.endsWith(".ts") && isRegisterHooksSupported()
            ? [
                // Source checkout under node: run the .ts exec entry with
                // the dev-mode hooks (tsx loader + src-condition
                // resolution), so dev works without a build (mirrors
                // bin/cli.js's launcher path). `process.execPath`, not
                // "node": the hooks are gated on THIS node's version. A
                // duplicate --import inherited via execArgv is harmless —
                // the second import of the same URL hits the module cache.
                process.execPath,
                ...process.execArgv,
                "--import",
                import.meta.resolve("../../../bin/register-dev-mode.js"),
                "--watch",
                "--watch-preserve-output",
                fileURLToPath(import.meta.resolve("alchemy/bin/exec.ts")),
              ]
            : [
                process.execPath,
                ...process.execArgv,
                ...transformTypesFlags(),
                "--watch",
                "--watch-preserve-output",
                fileURLToPath(import.meta.resolve("alchemy/bin/exec.js")),
              ];
      const child = yield* ChildProcess.make(command[0], command.slice(1), {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ALCHEMY_EXEC_OPTIONS: JSON.stringify(options),
          ALCHEMY_DEV: "true",
          ...(process.env.NODE_EXTRA_CA_CERTS
            ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
            : {}),
          [SPAWNER_URL_ENV_KEY]: spawner.url,
        },
        extendEnv: true,
        // Same process group as this supervisor: the exec child owns the
        // terminal (TUI stdin), so the tty's Ctrl+C must reach it directly.
        detached: false,
        // The watcher won't die while its inner exec child is still shutting
        // down — it forwards SIGTERM to the child and lingers. Without this
        // bound the kill finalizer waits on it forever (the double-Ctrl+C
        // hang); with it, a stuck shutdown escalates to SIGKILL.
        forceKillAfter: "3 seconds",
      });
      yield* child.exitCode;
    },
    (effect, args) =>
      Effect.provide(
        RpcSpawner.layerServer({
          profile: args.profile,
          envFile: Option.getOrUndefined(args.envFile),
        }),
      )(effect),
  ),
).pipe(Command.withDescription("Develop a stack with live reload"));
