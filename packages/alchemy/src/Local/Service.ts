import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { resolveMainPath } from "../Bundle/TempRoot.ts";
import { hashDirectory, type MemoOptions } from "../Command/Memo.ts";
import { havePropsChanged, isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { Stage } from "../Stage.ts";
import { sha256 } from "../Util/sha256.ts";
import * as ConsoleService from "effect/Console";
import {
  loadVite,
  makeViteLogger,
  viteBuildOutputPlugin,
} from "../Bundle/Vite.ts";
import {
  createHostRuntimeContext,
  Host,
  type HostRuntimeContext,
} from "./Process.ts";

/**
 * Binding contract accepted by a local {@link Service}: environment
 * variables injected into the detached process by capability bindings.
 */
export interface ServiceBinding {
  /** Environment variables injected into the process. */
  env?: Record<string, any>;
}

export interface ServiceProps extends PlatformProps {
  /**
   * Path to the entrypoint — a file path or a `file://` URL
   * (`import.meta.url` of the declaring module works). Bun runs
   * TypeScript directly; nothing is bundled:
   *
   * - **Effectful form** (an impl Effect is given): the detached
   *   process runs alchemy's Server entry, which imports `main`,
   *   resolves the declared handler (the Effectful Constructor), and
   *   runs its program — `host.run` loops plus a Bun HTTP server on
   *   `PORT` serving the returned `fetch`.
   * - **External form** (no impl): `main` is a self-contained script;
   *   the process runs it directly.
   */
  main?: string;
  /**
   * Named export of the handler within `main` (Effectful form).
   * @default "default"
   */
  handler?: string;
  /** Extra arguments passed after the entrypoint. */
  args?: string[];
  /**
   * Working directory for the process. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * PIN the port the service listens on. Usually omitted: the runtime
   * binds an ephemeral port and reports it back through the startup
   * handshake, and the observed port lands in the `port`/`url`
   * attributes. Set it only when something outside the stack needs a
   * stable address. Exposed to the process as `PORT` either way.
   */
  port?: number;
  /** Extra environment variables passed to the process. */
  env?: Record<string, any>;
  /**
   * @internal The carrier for `Local.Vite` — prefer that public face
   * (the same split as `Cloudflare.Website.Vite` over `Worker.vite`).
   * Builds the project at deploy (in-process, the project's own Vite)
   * and serves its client output from the SAME server as the
   * program's `fetch` routes.
   */
  vite?: {
    /** The Vite project root, relative to `cwd`. @default "." */
    root?: string;
  };
  /**
   * @internal Whether the constructor registered an HTTP surface
   * (`fetch`/RPC). Recorded from `exports.serves` at plan time by the
   * Platform machinery — not user-settable.
   */
  exports?: { serves?: boolean };
  /**
   * Controls which files are hashed to decide whether the service
   * should restart. By default every non-gitignored file in `cwd` is
   * hashed, plus the nearest lockfile. Provide explicit globs to narrow
   * the scope, or set `false` to skip source hashing (the service then
   * restarts only on prop changes or process death).
   *
   * @see {@link MemoOptions}
   * @default true
   */
  memo?: MemoOptions | boolean;
}

export interface Service extends Resource<
  "Local.Service",
  ServiceProps,
  // (attributes below; the 5th param names the provider required when
  // yielding the resource — `Local.providers()` supplies it)
  {
    /** OS process id of the running service. */
    pid: number;
    /** The resolved entrypoint path the process runs. */
    main: string;
    /** Path the process's stdout/stderr are appended to. */
    logFile: string;
    /**
     * The OBSERVED port the server bound — the driver-assigned one when
     * no `port` prop pinned it (Effectful form), or the pinned/declared
     * one otherwise. `undefined` when the program has no HTTP surface.
     */
    port: number | undefined;
    /** `http://localhost:{port}`, when the service serves HTTP. */
    url: string | undefined;
    /** The built client assets directory (`Local.Vite`), if any. */
    assets?: string | undefined;
    hash: {
      /** Content hash of the input files (restart detection), if memoized. */
      input: string | undefined;
      /** Hash of the deployed command + environment. */
      deploy: string;
    };
  },
  ServiceBinding,
  Provider.Provider<Service>
> {}

type ServiceServices = Host;
type ServiceShape = Main<ServiceServices>;

/**
 * A long-running LOCAL server — the Functions & Servers model pointed
 * at your own machine. The same Effectful Constructor you'd deploy to
 * a Cloudflare Worker or an ECS Service runs as a detached OS process
 * (it survives the CLI exiting): the reconciler tracks the `pid` in
 * state, restarts the process when its inputs change (props, source
 * files via content hash, injected env), and resurrects it when the
 * observed process is gone. `delete` stops it, idempotently. Nothing
 * is bundled — Bun runs the TypeScript directly.
 *
 * This is the local rung of the compute ladder: develop the app shape
 * here — the same program moves to a Worker/Container later by
 * swapping the resource.
 *
 *
 * ### Running an Effectful Server
 * **Example:** The Effectful Constructor, locally
 * ```typescript
 * export default class Api extends Local.Service<Api>()(
 *   "Api",
 *   { main: import.meta.url, port: 3000 },
 *   Effect.gen(function* () {
 *     return {
 *       fetch: Effect.gen(function* () {
 *         return HttpServerResponse.text("hello from localhost");
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Background Work
 * **Example:** A perpetual loop via Host
 * ```typescript
 * Effect.gen(function* () {
 *   const host = yield* Host;
 *   yield* host.run(pollGitHubForever);
 *   return { fetch: healthCheck };
 * })
 * ```
 *
 * Layers that own machinery should register it with {@link runOnHost}
 * (init-time) or {@link makeProcessScope} (post-init forks) so plain
 * `Effect.provide(MyLive)` on the constructor keeps fibers alive —
 * `Effect.provide`'s transient scope would otherwise tear them down
 * when init returns.

 *
 * ### External Scripts
 * **Example:** Run a self-contained script
 * ```typescript
 * const org = yield* Local.Service("AlchemyOrg", {
 *   main: "./src/local.ts",
 *   port: 7100,
 * });
 * return { url: org.url, pid: org.pid };
 * ```
 *
 * ### Restart on Source Change
 * **Example:** Narrow the watched inputs
 * ```typescript
 * yield* Local.Service("Api", {
 *   main: "./src/server.ts",
 *   memo: { include: ["src/**"] },
 * });
 * ```
 *
 * @resource
 */
export const Service: Platform<
  Service,
  ServiceServices,
  ServiceShape,
  HostRuntimeContext
> = Platform("Local.Service", {
  createRuntimeContext: createHostRuntimeContext("Local.Service"),
});

export const ServiceProvider = () =>
  Provider.effect(
    Service,
    Effect.gen(function* () {
      const stack = yield* Stack;
      const stage = yield* Stage;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcess = yield* Effect.promise(
        () => import("node:child_process"),
      );
      // The runtime entry shipped with alchemy (imports the user's main,
      // runs its program). `.ts` from source, `.js` from the built lib.
      const entryPath = yield* Effect.sync(
        () =>
          new URL(
            import.meta.url.endsWith(".ts") ? "./entry.ts" : "./entry.js",
            import.meta.url,
          ).pathname,
      );

      const alchemyEnv = {
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stage,
        ALCHEMY_PHASE: "runtime",
      };

      /**
       * Build the service's Vite project IN-PROCESS with the project's
       * own Vite (the `Cloudflare.Workers.Vite` machinery minus the
       * cloudflare plugin) and return the built CLIENT directory.
       */
      const viteBuild = (rootDir: string) =>
        Effect.gen(function* () {
          const outputPlugin = yield* viteBuildOutputPlugin({});
          const console = yield* ConsoleService.Console;
          // the project's OWN config drives the build (root, aliases,
          // plugins) — resolve it explicitly so an inline `root` never
          // shadows a config-file `root` (inline config wins in vite's
          // merge, which would break configs that relocate their root)
          const configFile = yield* Effect.findFirst(
            ["ts", "mts", "js", "mjs"].map((extension) =>
              path.join(rootDir, `vite.config.${extension}`),
            ),
            (candidate) => fs.exists(candidate).pipe(Effect.orDie),
          );
          yield* Effect.promise(async () => {
            const vite = await loadVite(rootDir);
            const builder = await vite.createBuilder(
              {
                ...(configFile._tag === "Some"
                  ? { configFile: configFile.value }
                  : { root: rootDir }),
                plugins: [outputPlugin.plugin],
                customLogger: makeViteLogger(console),
                logLevel: "warn",
              },
              null,
            );
            await builder.buildApp();
          });
          const { clientDirectory } = yield* outputPlugin.output;
          if (clientDirectory === undefined) {
            return yield* Effect.die(
              `Local.Vite: the build at '${rootDir}' produced no client output`,
            );
          }
          return clientDirectory;
        });

      /** Observe: is the recorded pid a live process? */
      const isAlive = (pid: number) =>
        Effect.sync(() => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });

      /** Idempotent stop: TERM, wait, KILL; a missing process is done. */
      const stop = Effect.fn(function* (pid: number) {
        if (!(yield* isAlive(pid))) return;
        yield* Effect.sync(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
        });
        const gone = yield* isAlive(pid).pipe(
          Effect.map((alive) => !alive),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (done) => done,
            times: 30,
          }),
        );
        if (!gone) {
          yield* Effect.sync(() => {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          });
        }
      });

      /**
       * Spawn `bun <main>` detached — `sh -c exec` so the shell is
       * REPLACED by bun (the recorded pid is the service's), stdio
       * appended to the log file, unref'd so the CLI can exit while the
       * service keeps running.
       */
      const start = Effect.fn(function* (options: {
        main: string;
        args: string[];
        cwd: string;
        logFile: string;
        env: Record<string, string>;
      }) {
        const command = ["bun", options.main, ...options.args]
          .map((part) => JSON.stringify(part))
          .join(" ");
        const child = yield* Effect.try({
          try: () =>
            childProcess.spawn(
              "/bin/sh",
              [
                "-c",
                `exec ${command} >> ${JSON.stringify(options.logFile)} 2>&1`,
              ],
              {
                cwd: options.cwd,
                env: { ...process.env, ...options.env },
                detached: true,
                stdio: "ignore",
              },
            ),
          catch: (cause) =>
            new Error(`Local.Service failed to spawn '${command}': ${cause}`),
        }).pipe(Effect.orDie);
        yield* Effect.sync(() => child.unref());
        const pid = child.pid;
        if (pid === undefined) {
          return yield* Effect.die(
            `Local.Service: spawn of '${command}' returned no pid — see ${options.logFile}`,
          );
        }
        return pid;
      });

      const inputHash = (news: ServiceProps) =>
        news.memo === false
          ? Effect.succeed(undefined)
          : hashDirectory({
              cwd: news.cwd,
              memo:
                news.memo === true || news.memo === undefined ? {} : news.memo,
            });

      /** The last lines of the service log, for startup failures. */
      const logTail = (logFile: string) =>
        fs.readFileString(logFile).pipe(
          Effect.map((text) => text.split("\n").slice(-30).join("\n")),
          Effect.catch(() => Effect.succeed("(no log output)")),
        );

      /**
       * Startup handshake: poll for the ready file the entry writes on
       * startup — `{ pid, port? }`, where `port` is the address the HTTP
       * server actually BOUND. A process that dies before reporting (or
       * never reports) fails the deploy with the log tail.
       */
      const awaitReady = Effect.fn(function* (options: {
        pid: number;
        readyFile: string;
        logFile: string;
      }) {
        const read = Effect.gen(function* () {
          if (yield* fs.exists(options.readyFile)) {
            const text = yield* fs.readFileString(options.readyFile);
            return JSON.parse(text) as { pid: number; port?: number };
          }
          if (!(yield* isAlive(options.pid))) {
            const tail = yield* logTail(options.logFile);
            return yield* Effect.die(
              `Local.Service process ${options.pid} exited before reporting ready — log tail:\n${tail}`,
            );
          }
          return undefined;
        }).pipe(Effect.orDie);

        const ready = yield* read.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("200 millis"),
            until: (report) => report !== undefined,
            times: 300, // 60s — the runtime imports TypeScript, unbundled
          }),
        );
        if (ready === undefined) {
          const tail = yield* logTail(options.logFile);
          return yield* Effect.die(
            `Local.Service process ${options.pid} did not report ready within 60s — log tail:\n${tail}`,
          );
        }
        return ready;
      });

      return {
        list: () => Effect.succeed([]),

        // Restart detection: props change, source change (content hash,
        // like Command.Exec's memo), or the observed process being GONE
        // (liveness repair — reconcile resurrects it).
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!output) return undefined;
          // LIVENESS first, before ANY resolution guard: a dead process
          // must be resurrected regardless of what plan-time props look
          // like. (The Effectful form's `exports.program` makes
          // `isResolved(news)` false for every Effectful service — a
          // wholesale bail here used to mask this check and the memo
          // hash entirely, so source edits and dead pids both planned
          // as noop.)
          if (!(yield* isAlive(output.pid))) {
            return { action: "update" as const };
          }
          // `exports.program` is the plan-time Effect (serialized as {}
          // in state) — never a meaningful diff input; strip it BEFORE
          // the resolution check so the check speaks for the fields the
          // comparison and the memo hash actually read. (The casts are
          // destructure-only: `isResolved` remains the runtime guard.)
          const { exports: _oldExports, ...oldsRest } = (olds ??
            {}) as ServiceProps;
          const { exports: _newExports, ...newsRest } = news as ServiceProps;
          if (!isResolved(newsRest)) return undefined;
          if (newsRest.memo === false || !output.hash.input) {
            return { action: "update" as const };
          }
          if (havePropsChanged(oldsRest as ServiceProps, newsRest)) {
            return { action: "update" as const };
          }
          const fresh = yield* inputHash(newsRest as ServiceProps);
          return {
            action:
              fresh === output.hash.input
                ? ("noop" as const)
                : ("update" as const),
          };
        }),

        // Observe → ensure → sync: compare the desired command + env
        // against the deployed hash and the live pid; restart only on
        // drift; resurrect when the process died.
        reconcile: Effect.fn(function* ({ id, news, output, bindings }) {
          if (!news.main) {
            return yield* Effect.die(
              `Local.Service '${id}' requires 'main' — the entrypoint to run`,
            );
          }
          const name = (yield* createPhysicalName({
            id,
            maxLength: 64,
            lowercase: true,
          })).replaceAll(/[^a-z0-9-]/g, "-");

          const main = yield* resolveMainPath(news.main);
          const args = news.args ?? [];
          const cwd = path.resolve(news.cwd ?? process.cwd());
          const dir = path.join(cwd, ".alchemy", "server", name);
          const logFile = path.join(dir, "server.log");
          const readyFile = path.join(dir, "ready.json");

          // Effectful form: run alchemy's Server entry, which imports
          // `main` and runs its declared program. External form: `main`
          // is a self-contained script — run it directly.
          const effectful = news.isExternal !== true;
          // Effectful form with an HTTP surface: the runtime binds PORT
          // and reports the OBSERVED port through the ready file. No
          // pinned port means PORT=0 — the OS assigns an ephemeral one.
          const serves = effectful && news.exports?.serves === true;
          // Local.Vite: (re)build when the inputs moved (or nothing is
          // recorded yet); a converged input hash reuses the recorded
          // client directory without building. Assets are read per
          // request, so a UI-only edit lands WITHOUT a restart.
          const freshInput = yield* inputHash(news);
          let assetsDir = output?.assets;
          if (
            news.vite &&
            (assetsDir === undefined || output?.hash.input !== freshInput)
          ) {
            assetsDir = yield* viteBuild(
              path.resolve(cwd, news.vite.root ?? "."),
            );
          }
          const env = renderEnv({
            ...collectBindingEnv(bindings),
            ...alchemyEnv,
            ...(effectful
              ? {
                  ALCHEMY_SERVICE_MAIN: main,
                  ALCHEMY_SERVICE_HANDLER: news.handler ?? "default",
                  ALCHEMY_SERVICE_READY_FILE: readyFile,
                }
              : {}),
            ...(assetsDir !== undefined
              ? { ALCHEMY_SERVICE_ASSETS: assetsDir }
              : {}),
            ...(serves
              ? { PORT: news.port ?? 0 }
              : news.port !== undefined
                ? { PORT: news.port }
                : {}),
            ...news.env,
          });
          const deployHash = yield* sha256(
            new TextEncoder().encode(JSON.stringify([main, args, cwd, env])),
          );

          // observed: the recorded process, if it still exists
          const alive = output !== undefined && (yield* isAlive(output.pid));
          if (output && alive && output.hash.deploy === deployHash) {
            // converged: same command, same env, still running — but the
            // input hash may have moved (that's why we were called)
            return {
              ...output,
              assets: assetsDir,
              hash: { ...output.hash, input: freshInput },
            };
          }

          if (output) yield* stop(output.pid);
          yield* fs.makeDirectory(dir, { recursive: true });
          // stale handshake from a previous incarnation
          yield* fs.remove(readyFile).pipe(Effect.ignore);
          const pid = yield* start({
            main: effectful ? entryPath : main,
            args,
            cwd,
            logFile,
            env,
          });

          // Startup handshake (Effectful form): wait until the entry
          // reports the process up — with the BOUND port when it serves.
          // A process that dies first fails loudly with its log tail.
          const ready = effectful
            ? yield* awaitReady({ pid, readyFile, logFile })
            : undefined;
          const port = ready?.port ?? news.port;

          return {
            pid,
            main,
            logFile,
            port,
            url: port !== undefined ? `http://localhost:${port}` : undefined,
            assets: assetsDir,
            hash: {
              input: freshInput,
              deploy: deployHash,
            },
          };
        }),

        // Idempotent: a process that's already gone is not an error.
        delete: Effect.fn(function* ({ output }) {
          if (!output) return;
          yield* stop(output.pid);
        }),
      };
    }),
  );

/** Render env values for `process.env`: strings raw, the rest JSON. */
const renderEnv = (env: Record<string, any>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string"
        ? value
        : Redacted.isRedacted(value)
          ? String(Redacted.value(value))
          : JSON.stringify(value ?? null),
    ]),
  );

const collectBindingEnv = (
  bindings?: ReadonlyArray<
    ResourceBinding<ServiceBinding> & { action?: string }
  >,
) =>
  (bindings ?? [])
    .filter((binding) => binding.action !== "delete")
    .map((binding) => binding?.data?.env)
    .reduce<Record<string, any>>((acc, value) => ({ ...acc, ...value }), {});
