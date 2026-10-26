import * as net from "node:net";
/**
 * Local provider of `Azure.Functions.Function` for `alchemy dev`: the
 * program runs in a Node.js process on the developer's machine instead of a
 * function app.
 *
 * Alchemy bundles `main` with the local entry (`Bootstrap/FunctionsLocal`,
 * or `Bootstrap/FunctionsLocalAsync` for an async Function), writes it to a
 * temporary directory, and runs `node index.mjs` with the same app settings
 * a deployed app gets, plus the Azurite endpoints (see
 * `Storage/Azurite.ts`). The URL (`http://localhost:<port>`) stays the same
 * across restarts, and a code change restarts the process.
 *
 * Bindings attach no role assignments locally, and only Storage queue and
 * timer triggers run (see `Bootstrap/FunctionsLocal.ts`).
 */
import * as LocalProvider from "alchemy/Local/LocalProvider";
import { LOCAL_ID_PREFIX } from "alchemy/ProviderMode";
import type { ResourceBinding } from "alchemy/Resource";
import { Stack } from "alchemy/Stack";
import { moduleExtension } from "alchemy/Util/Node";
import { makeResourceLogger } from "alchemy/Util/ResourceOutput";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import { READY_LINE } from "../Bootstrap/FunctionsLocalCore.ts";
import { azuriteEnv } from "../Storage/Azurite.ts";
import {
  Function,
  type FunctionAttributes,
  type FunctionBinding,
  type FunctionProps,
} from "./Function.ts";
import { collectBindings, envString, makeBundler } from "./host/internal.ts";

export class LocalFunctionFailed extends Data.TaggedError("Azure.Functions.LocalFunctionFailed")<{
  readonly fqn: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The restart surface: a new bundle or new settings restart the process. */
interface LocalFunctionConfig {
  codeHash: string;
  env: Record<string, string>;
  name: string | undefined;
  resourceGroup: string;
}

/** A TCP port nothing listens on, from the OS. */
const freePort = Effect.callback<number, LocalFunctionFailed>((resume) => {
  const server = net.createServer();
  server.once("error", (cause) =>
    resume(Effect.fail(new LocalFunctionFailed({ fqn: "", message: "no free port", cause }))),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => resume(Effect.succeed(port)));
  });
});

export const LocalFunctionProvider = () =>
  LocalProvider.make(
    Function,
    import.meta.resolve(`../Local${moduleExtension(import.meta.url)}`, import.meta.url),
    Effect.gen(function* () {
      const bundle = yield* makeBundler;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // Kept across restarts so the Function's URL never changes.
      const ports = new Map<string, number>();
      // The last bundle per resource, so `start` reuses what `resolveConfig` built.
      const bundles = new Map<string, Effect.Success<ReturnType<typeof bundle>>>();

      return {
        resolveConfig: Effect.fn(function* ({ fqn, news, bindings }) {
          const props = news as FunctionProps;
          const stack = yield* Stack;
          const built = yield* bundle({ ...props, local: true });
          bundles.set(fqn, built);
          const collected = collectBindings(bindings as ResourceBinding<FunctionBinding>[]);
          const env: Record<string, string> = {
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
          };
          for (const [key, value] of Object.entries({ ...collected.env, ...props.env })) {
            if (value !== undefined) env[key] = envString(value);
          }
          return {
            codeHash: built.codeHash,
            env,
            name: props.name,
            resourceGroup: props.resourceGroup ?? "",
          } satisfies LocalFunctionConfig;
        }),

        start: Effect.fn(function* ({ id, fqn, news, config, invalidate }) {
          const cached = bundles.get(fqn);
          const { files } =
            cached?.codeHash === config.codeHash
              ? cached
              : yield* bundle({ ...(news as FunctionProps), local: true });
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-azure-function-" });
          for (const file of files) {
            const target = path.join(dir, file.path);
            yield* fs.makeDirectory(path.dirname(target), { recursive: true });
            yield* typeof file.content === "string"
              ? fs.writeFileString(target, file.content)
              : fs.writeFile(target, file.content);
          }
          const port = ports.get(fqn) ?? (yield* freePort);
          ports.set(fqn, port);
          const emulator = yield* azuriteEnv;
          const child = yield* spawner.spawn(
            ChildProcess.make("node", ["index.mjs"], {
              cwd: dir,
              env: { ...config.env, ...emulator, PORT: String(port) },
              extendEnv: true,
            }),
          );

          // Mirror the process output into the dev log; readiness is the
          // server's READY line.
          const log = makeResourceLogger(fqn);
          const ready = yield* Deferred.make<void>();
          const mirror = (channel: "stdout" | "stderr") =>
            child[channel].pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach((line) =>
                line === READY_LINE ? Deferred.succeed(ready, undefined) : log(channel, line),
              ),
              Effect.forkScoped,
            );
          yield* mirror("stdout");
          yield* mirror("stderr");
          yield* Effect.raceFirst(
            Deferred.await(ready).pipe(
              Effect.timeoutOrElse({
                duration: "60 seconds",
                orElse: () =>
                  Effect.fail(
                    new LocalFunctionFailed({
                      fqn,
                      message: "the process did not start serving in 60 s",
                    }),
                  ),
              }),
            ),
            child.exitCode.pipe(
              Effect.flatMap((exitCode) =>
                Effect.fail(
                  new LocalFunctionFailed({
                    fqn,
                    message: `the process exited with code ${exitCode}`,
                  }),
                ),
              ),
            ),
          );
          // A crash after readiness drops the instance, so the next plan restarts it.
          yield* child.exitCode.pipe(
            Effect.exit,
            Effect.flatMap(() => invalidate),
            Effect.forkScoped,
          );

          const host = `localhost:${port}`;
          return {
            functionAppName: config.name ?? id,
            functionAppId: `${LOCAL_ID_PREFIX}${fqn}`,
            resourceGroup: config.resourceGroup,
            location: "local",
            defaultHostName: host,
            url: `http://${host}`,
            principalId: undefined,
            storageAccountName: undefined,
            managedApp: true,
            codeHash: config.codeHash,
            settingKeys: Object.keys(config.env).sort(),
            eventSubscriptions: [],
          } satisfies FunctionAttributes;
        }, Effect.provideService(FileSystem.FileSystem, fs), Effect.provideService(Path.Path, path)),

        stop: ({ fqn }) =>
          Effect.sync(() => {
            ports.delete(fqn);
            bundles.delete(fqn);
          }),
      } satisfies LocalProvider.LocalProviderSpec<Function, LocalFunctionConfig>;
    }),
  );
