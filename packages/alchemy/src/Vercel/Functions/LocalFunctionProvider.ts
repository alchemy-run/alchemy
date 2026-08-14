/**
 * The dev-mode (`alchemy dev`) provider for `Vercel.Function` — emulates a
 * Fluid Function on the developer's machine instead of deploying it
 * (DESIGN §"Wave 3", ProviderMode doctrine).
 *
 * Architecture (mirrors `Cloudflare/Workers/LocalWorkerProvider.ts`, one
 * size smaller):
 *
 * - **Bundling**: the SAME rolldown options as the deploy path
 *   (`functionRolldownOptions`) in watch mode, with a dev virtual entry
 *   that mounts the user module (async mode) or the `makeVercelBridge`
 *   wrapper (Effect mode) inside the {@link DevShim} — a Node HTTP server
 *   implementing Vercel's full launcher matrix (`{ fetch }`, method
 *   exports, `(req, res)`). `__ALCHEMY_RUNTIME__` folds to `true` exactly
 *   like a deployed bundle.
 * - **Isolation**: each Function runs as its own child process, because
 *   each deployed Vercel Function owns its `process.env`. The provider
 *   injects `VERCEL=1`, `VERCEL_ENV=development`, `VERCEL_URL`,
 *   `VERCEL_DEPLOYMENT_ID=dev:…`, the resolved binding env (Redacted
 *   unwrapped at the process boundary), and `CRON_SECRET` when crons are
 *   registered.
 * - **URL stability**: a per-Function proxy
 *   ({@link serveFunctionProxy}) owns the stable `http://localhost:<port>`
 *   URL OUTSIDE the instance scope (torn down only in `stop`); rebuilds
 *   and restarts are make-before-break — the previous child serves until
 *   the replacement is ready, then the proxy cuts over.
 * - **Cron emulation**: an instance-scoped timer per registered cron
 *   entry, firing `GET <path>` through the proxy with
 *   `user-agent: vercel-cron/1.0` and `Authorization: Bearer $CRON_SECRET`
 *   — byte-identical to the platform invoker's request shape.
 * - **Queues**: when the Function registered `subscribe` bindings, the dev
 *   entry also mounts the queue-mode bridge and the shim serves it at
 *   `QUEUE_DELIVERY_PATH`; the running instance is published in
 *   {@link LocalFunctionState}, from which the sidecar's
 *   {@link LocalQueueBroker} push-delivers. Every child is pointed at the
 *   broker's data plane via `VERCEL_QUEUE_BASE_URL`/`VERCEL_QUEUE_TOKEN`
 *   (the official `vercel dev` env contract), so `SendMessage` /
 *   `ReceiveMessages` / the consumer bridge's ack work locally unchanged.
 *
 * `source`/`prebuilt` Functions (Websites) have no local emulation yet —
 * they must be piped through `Alchemy.remote()` in dev.
 */
import * as Cause from "effect/Cause";
import * as Cron from "effect/Cron";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { fileURLToPath } from "node:url";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import * as TempRoot from "../../Bundle/TempRoot.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { sha256 } from "../../Util/sha256.ts";
import type {
  BuildOutputRoute,
  CronEntry,
  QueueTriggerEntry,
} from "../Deploy/BuildOutput.ts";
import { LOCAL_ENTRY_URL, LocalFunctionState } from "../LocalRuntime.ts";
import {
  DEV_QUEUE_TOKEN,
  LocalQueueBroker,
} from "../Queues/LocalQueueBroker.ts";
import {
  DEV_PORT_ENV,
  DEV_READY_PREFIX,
  DEV_READY_SUFFIX,
  QUEUE_DELIVERY_PATH,
} from "./DevShim.ts";
import { CRON_SECRET_ENV } from "./FunctionBridge.ts";
import { functionRolldownOptions } from "./FunctionBundle.ts";
import { Function, isSelfUrl, type FunctionProps } from "./Function.ts";
import { serveFunctionProxy } from "./LocalFunctionProxy.ts";

// Resolved lazily at bundle time, NOT at module load (mirrors ViteChild's
// resolveRunner note): `import.meta.resolve` only exists in Node/bun.
const shimModulePath = () =>
  fileURLToPath(
    import.meta.resolve(
      import.meta.url.endsWith(".ts") ? "./DevShim.ts" : "./DevShim.js",
    ),
  );

/** How long a spawned child may take to print its readiness line. */
const CHILD_READY_TIMEOUT = "60 seconds";

export const LocalFunctionProvider = () =>
  LocalProvider.make(
    Function,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fs = yield* FileSystem.FileSystem;
      const stack = yield* Stack;
      const { dotAlchemy } = yield* AlchemyContext;
      const localState = yield* LocalFunctionState;
      const httpClient = yield* HttpClient.HttpClient;
      const virtualEntry = yield* Bundle.virtualEntryPlugin;
      const rootScope = yield* Effect.scope;
      // The local queue data plane (send/receive/ack) every dev child is
      // pointed at via VERCEL_QUEUE_BASE_URL — the same env contract the
      // official `vercel dev` uses. Serving is idempotent; the server lives
      // in the provider's root scope.
      const queueBroker = yield* LocalQueueBroker;
      const queueBrokerUrl = yield* queueBroker.serve;

      const baseDirectory = path.join(dotAlchemy, "local", "vercel");

      // ── Proxies: deliberately NOT owned by the per-instance scope — they
      // survive restarts so the Function's URL stays stable across rebuilds
      // and config changes. Torn down by `stop` on delete.
      const proxies = new Map<
        string,
        {
          port: number | undefined;
          instance: { url: string; set: (next: string) => Effect.Effect<void> };
          scope: Scope.Closeable;
        }
      >();

      const ensureProxy = Effect.fn(function* (
        id: string,
        port: number | undefined,
      ) {
        const existing = proxies.get(id);
        if (existing !== undefined) {
          if (existing.port === port) return existing.instance;
          yield* Scope.close(existing.scope, Exit.void);
          proxies.delete(id);
        }
        const scope = yield* Scope.fork(rootScope);
        const instance = yield* serveFunctionProxy({ port }).pipe(
          Scope.provide(scope),
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Scope.close(scope, exit) : Effect.void,
          ),
        );
        proxies.set(id, { port, instance, scope });
        return instance;
      });

      // ── Running children: keyed by logical id, scopes forked from the
      // provider root scope (NOT the instance scope) so the last good child
      // keeps serving across instance restarts until its replacement's
      // first serve completes (make-before-break). Reclaimed by the next
      // successful serve, by `stop`, or by provider shutdown.
      const children = new Map<
        string,
        { scope: Scope.Closeable; directory: string; token: object }
      >();

      // Serializes serves per id so an in-flight rebuild serve can never
      // interleave with another and leak a child scope.
      const serveLocks = new Map<string, Semaphore.Semaphore>();
      const serveLock = (id: string) => {
        let lock = serveLocks.get(id);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          serveLocks.set(id, lock);
        }
        return lock;
      };

      const closeChild = Effect.fn(function* (id: string) {
        const existing = children.get(id);
        if (existing !== undefined) {
          children.delete(id);
          yield* Scope.close(existing.scope, Exit.void);
          yield* fs
            .remove(existing.directory, { recursive: true })
            .pipe(Effect.ignore);
        }
      });

      /**
       * The restart-relevant, canonically-hashable view of a local
       * Function's desired state — `LocalProvider`'s `resolveConfig`.
       * Plain data only; the bundler and child-process wiring are
       * materialized in `start`.
       */
      const resolveConfig = Effect.fn(function* ({
        id,
        news,
        bindings,
      }: LocalProvider.LocalProviderInput<Function>) {
        const props = news as FunctionProps;
        if (props.source !== undefined || props.prebuilt !== undefined) {
          return yield* Effect.die(
            `Vercel.Function(${id}): \`source\`/\`prebuilt\` Functions (Websites) have no local dev emulation yet — pipe the resource through Alchemy.remote() to deploy it live during dev`,
          );
        }
        const name =
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 100, lowercase: true }));
        // Merge the binding channel (same shape as the live provider's
        // collectBindings).
        const active = bindings.filter(
          (b: ResourceBinding<Function["Binding"]> & { action?: string }) =>
            b.action !== "delete",
        );
        const bindingEnv = active
          .map((b) => b?.data?.env)
          .reduce<Record<string, unknown>>((acc, e) => ({ ...acc, ...e }), {});
        const crons: CronEntry[] = active.flatMap((b) => b?.data?.crons ?? []);
        const routes: BuildOutputRoute[] = active.flatMap(
          (b) => b?.data?.routes ?? [],
        );
        const queues: QueueTriggerEntry[] = active.flatMap(
          (b) => b?.data?.queues ?? [],
        );
        return {
          id,
          name,
          main:
            props.main !== undefined
              ? yield* TempRoot.resolveMainPath(props.main)
              : undefined,
          /** Inline module source (shipped verbatim on deploy) — part of
           * the hashed config so editing it restarts the instance. */
          script: props.script,
          isExternal: props.isExternal ?? false,
          /** Bundler overrides. Function-valued members (plugins) are
           * dropped by the canonical hasher — same caveat as the live
           * Cloudflare local config. */
          build: props.build,
          /** User env (Redacted preserved — the canonical hasher unwraps). */
          env: props.env,
          bindingEnv,
          crons,
          /** Contributed Build Output routes. Hash-relevant, but the local
           * shim serves the single function for every path (matching the
           * deployed filesystem-handler fallthrough for a lone function) —
           * route entries are not interpreted locally. */
          routes,
          queues,
          runtime: props.runtime,
          port:
            typeof props.dev?.port === "number" ? props.dev.port : undefined,
        };
      });

      type LocalFunctionConfig = Effect.Success<
        ReturnType<typeof resolveConfig>
      >;

      const deriveCronSecret = (name: string) =>
        sha256(`${stack.name}:${stack.stage}:${name}:cron-secret`);

      /**
       * The child's environment: resolved binding env ⊎ props env (self-URL
       * sentinels substituted with the stable proxy URL, Redacted unwrapped
       * at the process boundary, non-strings JSON-coerced like the live
       * `coerceEnvValue`), plus the Vercel platform variables a deployed
       * instance sees.
       */
      const resolveChildEnv = (input: {
        config: LocalFunctionConfig;
        url: string;
        deploymentId: string;
        cronSecret: string | undefined;
      }): Record<string, string> => {
        const { config, url, deploymentId, cronSecret } = input;
        const host = url.replace(/^https?:\/\//, "");
        const env: Record<string, string> = {};
        // Props env wins over binding env on key conflict (matching the
        // live provider) — EXCEPT that an `undefined` prop value must not
        // shadow a binding value: `stripEffects` nulls Effect-valued prop
        // leaves (e.g. the `Function.URL` sentinel), whose plain marker
        // arrives through the binding channel instead.
        const merged: Record<string, unknown> = { ...config.bindingEnv };
        for (const [key, value] of Object.entries(config.env ?? {})) {
          if (value !== undefined) merged[key] = value;
        }
        for (const [key, raw] of Object.entries(merged)) {
          if (raw === undefined) continue;
          const value = isSelfUrl(raw) ? url : raw;
          env[key] = Redacted.isRedacted(value)
            ? String(Redacted.value(value))
            : typeof value === "string"
              ? value
              : JSON.stringify(value);
        }
        if (cronSecret !== undefined) {
          env[CRON_SECRET_ENV] = cronSecret;
        }
        return {
          // Queue clients (ours and `@vercel/queue`) redirect to the local
          // broker via these; user env may override them.
          VERCEL_QUEUE_BASE_URL: queueBrokerUrl,
          VERCEL_QUEUE_TOKEN: DEV_QUEUE_TOKEN,
          ...env,
          VERCEL: "1",
          VERCEL_ENV: "development",
          VERCEL_TARGET_ENV: "development",
          VERCEL_URL: host,
          VERCEL_BRANCH_URL: host,
          VERCEL_PROJECT_PRODUCTION_URL: host,
          VERCEL_DEPLOYMENT_ID: deploymentId,
          VERCEL_REGION: "dev1",
          NODE_ENV: "development",
        };
      };

      /** The generated dev bundle entry (see the module doc). */
      const devEntryCode = (config: LocalFunctionConfig) => {
        const shim = JSON.stringify(shimModulePath());
        const stackMeta = JSON.stringify({
          name: stack.name,
          stage: stack.stage,
        });
        return (importPath: string) => {
          if (config.isExternal || config.script !== undefined) {
            return `
import * as entrypoint from ${JSON.stringify(importPath)};
import { startVercelFunctionDevServer } from ${shim};
startVercelFunctionDevServer({ module: entrypoint });
`;
          }
          const hasQueues = config.queues.length > 0;
          return `
import entrypoint from ${JSON.stringify(importPath)};
import { makeVercelBridge } from "alchemy/Vercel";
import { startVercelFunctionDevServer } from ${shim};
const stack = ${stackMeta};
const bridge = makeVercelBridge(entrypoint, { stack });
${
  hasQueues
    ? `const queueBridge = makeVercelBridge(entrypoint, { stack, mode: "queue" });`
    : ""
}
startVercelFunctionDevServer({
  module: { default: bridge },${
    hasQueues ? `\n  queueFetch: (request) => queueBridge.fetch(request),` : ""
  }
});
`;
        };
      };

      /** Spawn one child serving the written bundle; resolves at readiness. */
      const spawnChild = Effect.fn(function* (input: {
        id: string;
        entry: string;
        directory: string;
        env: Record<string, string>;
      }) {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const isBun =
          typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            isBun ? ["run", input.entry] : [input.entry],
            {
              cwd: input.directory,
              env: { ...input.env, [DEV_PORT_ENV]: "0" },
              extendEnv: true,
              stdout: "pipe",
              stderr: "pipe",
            },
          ),
        );
        const ready = yield* Deferred.make<string>();
        const mirror = (channel: "stdout" | "stderr") =>
          child[channel].pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                const start = line.indexOf(DEV_READY_PREFIX);
                const end = line.indexOf(DEV_READY_SUFFIX);
                if (start !== -1 && end > start) {
                  Deferred.doneUnsafe(
                    ready,
                    Effect.succeed(
                      line.slice(start + DEV_READY_PREFIX.length, end),
                    ),
                  );
                  return;
                }
                process[channel].write(`${input.id} | ${line}\n`);
              }),
            ),
            Effect.forkScoped,
          );
        yield* mirror("stdout");
        yield* mirror("stderr");
        const url = yield* Effect.raceAllFirst([
          Deferred.await(ready).pipe(
            Effect.timeoutOrElse({
              duration: CHILD_READY_TIMEOUT,
              orElse: () =>
                Effect.die(
                  `Vercel.Function(${input.id}): local dev server did not become ready within ${CHILD_READY_TIMEOUT}`,
                ),
            }),
          ),
          child.exitCode.pipe(
            Effect.exit,
            Effect.flatMap((exit) =>
              Effect.die(
                `Vercel.Function(${input.id}): local dev server exited before becoming ready (${
                  exit._tag === "Success" ? `code ${exit.value}` : "spawn error"
                })`,
              ),
            ),
          ),
        ]);
        return { url, exitCode: child.exitCode };
      });

      /**
       * Serve one bundle with make-before-break semantics: write it to a
       * fresh generation directory, boot the replacement child, cut the
       * proxy over, then tear the previous child down.
       */
      const serveBundle = (input: {
        id: string;
        bundle: Bundle.BundleOutput;
        env: Record<string, string>;
        proxy: { url: string; set: (next: string) => Effect.Effect<void> };
        invalidate: Effect.Effect<void>;
        generation: () => number;
      }) =>
        Semaphore.withPermits(
          serveLock(input.id),
          1,
        )(
          // Once the replacement child is up it must be recorded and the
          // previous child must be closed — an interrupt tearing this in
          // half would leak a process until provider shutdown.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const directory = path.join(
                baseDirectory,
                encodeURIComponent(input.id),
                String(input.generation()),
              );
              yield* fs.makeDirectory(directory, { recursive: true });
              for (const file of input.bundle.files) {
                const filePath = path.join(directory, file.path);
                yield* fs.makeDirectory(path.dirname(filePath), {
                  recursive: true,
                });
                yield* typeof file.content === "string"
                  ? fs.writeFileString(filePath, file.content)
                  : fs.writeFile(filePath, file.content);
              }
              const previous = children.get(input.id);
              const token = {};
              const scope = yield* Scope.fork(rootScope);
              const child = yield* restore(
                spawnChild({
                  id: input.id,
                  entry: path.join(directory, input.bundle.files[0].path),
                  directory,
                  env: input.env,
                }).pipe(Scope.provide(scope)),
              ).pipe(
                Effect.onExit((exit) =>
                  exit._tag === "Failure"
                    ? Scope.close(scope, exit)
                    : Effect.void,
                ),
              );
              children.set(input.id, { scope, directory, token });
              // Unexpected child death: mark the instance for update on the
              // next plan (guarded so a superseded child's death is inert).
              yield* child.exitCode.pipe(
                Effect.exit,
                Effect.flatMap(() =>
                  Effect.suspend(() =>
                    children.get(input.id)?.token === token
                      ? Effect.andThen(
                          Effect.sync(() => children.delete(input.id)),
                          input.invalidate,
                        )
                      : Effect.void,
                  ),
                ),
                Effect.forkIn(scope),
              );
              yield* input.proxy.set(child.url);
              if (previous !== undefined) {
                yield* Scope.close(previous.scope, Exit.void).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[${input.id}] Failed to stop previous local function instance`,
                      Cause.squash(cause),
                    ),
                  ),
                );
                // The generation counter is per-instance, so the first
                // serve after a restart may have REUSED the previous
                // child's directory — never delete the one just served.
                if (previous.directory !== directory) {
                  yield* fs
                    .remove(previous.directory, { recursive: true })
                    .pipe(Effect.ignore);
                }
              }
            }),
          ),
        );

      return {
        resolveConfig,

        // The physical name only survives an update when it isn't changing.
        stables: ({ output, config }) =>
          Effect.succeed(
            output?.projectName === config.name
              ? (["projectId", "projectName"] as ["projectId", "projectName"])
              : undefined,
          ),

        // Pre-create keeps circular bindings (InvokeFunction A↔B) working
        // in dev: the stub already carries the stable proxy URL.
        precreate: Effect.fn(function* ({ id, news }) {
          const props = news as FunctionProps;
          const name =
            typeof props.name === "string"
              ? props.name
              : yield* createPhysicalName({
                  id,
                  maxLength: 100,
                  lowercase: true,
                });
          const proxy = yield* ensureProxy(
            id,
            typeof props.dev?.port === "number" ? props.dev.port : undefined,
          );
          return {
            projectId: `dev:${name}`,
            projectName: name,
            deploymentId: "",
            url: proxy.url,
            stageAlias: undefined,
            hash: { artifact: "", code: "", env: "" },
            managedEnv: [],
            protectionBypass: undefined,
            cronSecret: undefined,
          } satisfies Function["Attributes"];
        }),

        start: Effect.fn(function* ({ id, config, invalidate }) {
          // Satisfy the proxy's HttpClient requirement from the layer-scope
          // capture — LocalProvider.make's start contract doesn't carry
          // HttpClient in its R.
          const proxy = yield* ensureProxy(id, config.port).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
          const configHash = yield* LocalProvider.canonicalHash(config);
          const deploymentId = `dev:dpl_${configHash.slice(0, 24)}`;
          const cronSecret =
            config.crons.length > 0
              ? yield* deriveCronSecret(config.name)
              : undefined;
          const env = resolveChildEnv({
            config,
            url: proxy.url,
            deploymentId,
            cronSecret,
          });

          let generation = 0;
          const nextGeneration = () => ++generation;
          const serve = (bundle: Bundle.BundleOutput) =>
            serveBundle({
              id,
              bundle,
              env,
              proxy,
              invalidate,
              generation: nextGeneration,
            });

          // ── Bundle + serve. Inline `script` is written to a synthetic
          // entry file and built once (the script string is part of the
          // hashed config, so edits restart the instance); `main` runs the
          // rolldown watcher and re-serves every successful rebuild.
          const entryFile = yield* Effect.gen(function* () {
            if (config.script !== undefined) {
              const scriptPath = path.join(
                baseDirectory,
                encodeURIComponent(id),
                "script",
                "index.mjs",
              );
              yield* fs.makeDirectory(path.dirname(scriptPath), {
                recursive: true,
              });
              yield* fs.writeFileString(scriptPath, config.script);
              return scriptPath;
            }
            if (config.main === undefined) {
              return yield* Effect.die(
                `Vercel.Function(${id}): one of \`main\` or \`script\` is required`,
              );
            }
            return config.main;
          });
          const cwd = yield* TempRoot.findCwdForBundle(entryFile);
          const { inputOptions, outputOptions } = functionRolldownOptions({
            realMain: entryFile,
            cwd,
            build: config.build,
            entryPlugin: virtualEntry(devEntryCode(config)),
          });

          if (config.script !== undefined) {
            const bundle = yield* Bundle.build(
              inputOptions,
              outputOptions,
              config.build,
            );
            yield* serve(bundle).pipe(
              Effect.catchCause((cause) =>
                Effect.logError(`[${id}] Error`, Cause.squash(cause)),
              ),
              Effect.forkScoped,
            );
          } else {
            // Watch loop, forked into the instance scope: serve every
            // successful bundle; log build/serve errors without tearing the
            // instance down (fix the code, the watcher rebuilds).
            let startedAt = Date.now();
            let status: "start" | "update" = "start";
            yield* Bundle.watch(inputOptions, outputOptions, config.build).pipe(
              Stream.tap((event) => {
                if (event._tag === "Start") {
                  startedAt = Date.now();
                  return status === "update"
                    ? Effect.log(`[${id}] Rebuilding`)
                    : Effect.void;
                }
                if (event._tag === "Error") {
                  return Effect.logError(`[${id}] Bundle error`, event.error);
                }
                return Effect.void;
              }),
              Stream.filterMap((event) =>
                event._tag === "Success"
                  ? Result.succeed(event.output)
                  : Result.failVoid,
              ),
              Stream.mapEffect((bundle) =>
                serve(bundle).pipe(
                  Effect.exit,
                  Effect.tap((exit) => {
                    if (exit._tag === "Success") {
                      const message = Effect.log(
                        `[${id}] ${status === "update" ? "Updated" : "Started"} in ${Math.round(Date.now() - startedAt)}ms → ${proxy.url}`,
                      );
                      status = "update";
                      return message;
                    }
                    return Effect.logError(
                      `[${id}] Error`,
                      Cause.squash(exit.cause),
                    );
                  }),
                ),
              ),
              Stream.runDrain,
              Effect.forkScoped,
            );
          }

          // ── Cron emulation: instance-scoped timers firing the platform
          // invoker's exact request shape at each schedule match (UTC).
          for (const entry of config.crons) {
            const parsed = Cron.parse(entry.schedule, "UTC");
            if (Result.isFailure(parsed)) {
              yield* Effect.logWarning(
                `[${id}] Invalid cron expression "${entry.schedule}": ${parsed.failure.message}`,
              );
              continue;
            }
            yield* httpClient
              .execute(
                HttpClientRequest.get(`${proxy.url}${entry.path}`).pipe(
                  HttpClientRequest.setHeaders({
                    "user-agent": "vercel-cron/1.0",
                    authorization: `Bearer ${cronSecret!}`,
                  }),
                ),
              )
              .pipe(
                Effect.asVoid,
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    `[${id}] Local cron ${entry.schedule} fire failed`,
                    Cause.squash(cause),
                  ),
                ),
                Effect.schedule(Schedule.cron(parsed.success)),
                Effect.forkScoped,
              );
          }

          // ── Publish the running instance for sibling local services (the
          // phase-2 queue-delivery seam, see LocalRuntime.ts).
          MutableHashMap.set(localState.functions, id, {
            functionId: id,
            url: proxy.url,
            deploymentId,
            queues: config.queues,
            queueEndpoint:
              config.queues.length > 0
                ? `${proxy.url}${QUEUE_DELIVERY_PATH}`
                : undefined,
            cronSecret,
          });

          return {
            projectId: `dev:${config.name}`,
            projectName: config.name,
            deploymentId,
            url: proxy.url,
            stageAlias: undefined,
            hash: { artifact: "", code: configHash, env: "" },
            managedEnv: [],
            protectionBypass: undefined,
            cronSecret:
              cronSecret !== undefined ? Redacted.make(cronSecret) : undefined,
          } satisfies Function["Attributes"];
        }),

        stop: Effect.fn(function* ({ id }) {
          // Cross-restart state: the running child (which outlives instance
          // scopes for make-before-break) and the URL proxy live outside
          // instance scopes and are only reclaimed on a real delete.
          MutableHashMap.remove(localState.functions, id);
          yield* closeChild(id);
          const proxy = proxies.get(id);
          if (proxy !== undefined) {
            proxies.delete(id);
            yield* Scope.close(proxy.scope, Exit.void);
          }
        }),
      } satisfies LocalProvider.LocalProviderSpec<
        Function,
        LocalFunctionConfig,
        // `spawnChild` (ChildProcessSpawner) and the bundle writer
        // (FileSystem/Path) run inside `start`.
        | ChildProcessSpawner.ChildProcessSpawner
        | FileSystem.FileSystem
        | Path.Path
      >;
    }),
  );
