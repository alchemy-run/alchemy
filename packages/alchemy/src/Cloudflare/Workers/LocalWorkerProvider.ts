import {
  Runtime,
  type BindingHook,
  type BindingServices,
  type HyperdriveOrigin,
  type Module,
  type DurableObjectNamespace as RuntimeDurableObject,
  type QueueConsumer as RuntimeQueueConsumer,
  type RuntimeServices,
  type Workflow as RuntimeWorkflow,
} from "@distilled.cloud/cloudflare-runtime";
import {
  Ai,
  AiSearch,
  AnalyticsEngine,
  Artifacts,
  Assets,
  Browser,
  D1,
  Data,
  DispatchNamespace,
  DurableObjectNamespace,
  Flagship,
  Hyperdrive,
  Images,
  Json,
  KvNamespace,
  MtlsCertificate,
  Pipelines,
  Queue,
  R2Bucket,
  RateLimit,
  SendEmail,
  Service,
  Text,
  Vectorize,
  VersionMetadata,
  WasmModule,
  WorkerLoader,
  Workflows,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import type { ContainerImage } from "@distilled.cloud/cloudflare-runtime/Docker";
import * as WorkerProxy from "@distilled.cloud/cloudflare-runtime/proxy/WorkerProxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import type * as FileSystem from "effect/FileSystem";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as Bundle from "../../Bundle/Bundle.ts";
import * as LocalProvider from "../../Local/LocalProvider.ts";
import { Stack } from "../../Stack.ts";
import { unwrapRedacted } from "../../Util/index.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import {
  isLocalId,
  LOCAL_ENTRY_URL,
  LocalRuntimeState,
} from "../LocalRuntime.ts";
import type { WorkerAssetsConfig, WorkerProps } from "../Workers/Worker.ts";
import { readAssetsConfigFiles } from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isPythonMain, watchPythonWorkerBundle } from "./PythonWorkerBundle.ts";
import { isSelfUrl, Worker } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import { WorkerBundle, type WorkerBundleOptions } from "./WorkerBundle.ts";
import { createWorkerName } from "./WorkerName.ts";

/** Local dev-server options (the worker-mode arm of `WorkerProps["dev"]`). */
type DevServerOptions = Extract<WorkerProps["dev"], { mode?: "worker" }> & {
  port: number;
};

export class WorkerValidationError extends Schema.TaggedErrorClass<WorkerValidationError>()(
  "WorkerValidationError",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    value: Schema.Unknown,
  },
) {}

export const LocalWorkerProvider = () =>
  LocalProvider.make(
    Worker,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      const runtime = yield* Runtime;
      const stack = yield* Stack;
      const path = yield* Path.Path;
      const localRuntimeState = yield* LocalRuntimeState;
      const workerProxy = yield* WorkerProxy.WorkerProxy;
      const cloudflareEnv = yield* CloudflareEnvironment;
      const context = yield* Effect.context<RuntimeServices>();
      const rootScope = yield* Effect.scope;

      // Proxies are deliberately NOT owned by the per-instance scope: they
      // survive restarts so the worker's URL stays stable across rebuilds
      // and config changes. Torn down by `stop` on delete.
      const proxyInstances = new Map<
        string,
        {
          serverOptions: DevServerOptions;
          instance: WorkerProxy.WorkerProxyInstance;
          scope: Scope.Closeable;
        }
      >();

      const getQueueConsumers = Effect.fn(function* (scriptName: string) {
        const consumers: RuntimeQueueConsumer[] = [];
        for (const consumer of MutableHashMap.values(
          localRuntimeState.queueConsumers,
        )) {
          if (consumer.scriptName === scriptName) {
            const queue = MutableHashMap.get(
              localRuntimeState.queues,
              consumer.queueId,
            ).pipe(Option.getOrUndefined);
            if (queue) {
              consumers.push({
                queueName: queue.queueName,
                deadLetterQueue: consumer.deadLetterQueue,
                ...consumer.settings,
              });
            } else {
              return yield* Effect.die(`Queue ${consumer.queueId} not found`);
            }
          }
        }
        return consumers;
      });

      const startProxy = Effect.fn(function* (
        id: string,
        serverOptions: DevServerOptions,
      ) {
        const scope = yield* Scope.fork(rootScope);
        const instance = yield* workerProxy
          .serve(serverOptions)
          .pipe(Scope.provide(scope));
        proxyInstances.set(id, { serverOptions, instance, scope });
        return instance;
      });

      const stopProxy = Effect.fn(function* (id: string) {
        const existing = proxyInstances.get(id);
        if (existing) {
          yield* Scope.close(existing.scope, Exit.void);
          proxyInstances.delete(id);
        }
      });

      const maybeStartProxy = Effect.fn(function* (
        id: string,
        serverOptions: DevServerOptions,
      ) {
        const existing = proxyInstances.get(id);
        if (existing) {
          if (Equal.equals(existing.serverOptions, serverOptions)) {
            return existing.instance;
          }
          yield* stopProxy(id);
        }
        return yield* startProxy(id, serverOptions);
      });

      const toRuntimeModules = Effect.fn(function* (
        bundle: Bundle.BundleOutput,
      ) {
        const modules: Module[] = [];
        for (const file of bundle.files) {
          // Vendored Python packages are opaque Data modules named by their
          // `python_modules/<relpath>` — mirroring the deploy path — except
          // the `workers-runtime-sdk` JS shims, which the runtime imports
          // as ES modules via `import_from_javascript()`.
          if (file.path.startsWith("python_modules/")) {
            const isJsShim =
              file.path.startsWith("python_modules/workers/") &&
              /\.m?js$/.test(file.path);
            modules.push(
              isJsShim
                ? {
                    name: file.path,
                    type: "ESModule",
                    content:
                      typeof file.content === "string"
                        ? file.content
                        : new TextDecoder().decode(file.content),
                  }
                : {
                    name: file.path,
                    type: "Data",
                    content:
                      typeof file.content === "string"
                        ? new TextEncoder().encode(file.content)
                        : file.content,
                  },
            );
            continue;
          }
          const ext = path.extname(file.path);
          const type = moduleTypeFromExtension(ext);
          if (type === "SourceMap") continue;
          if (type === "Data" || type === "Wasm") {
            if (!(file.content instanceof Uint8Array)) {
              return yield* new WorkerValidationError({
                message: `Expected Uint8Array for ${file.path} (${type})`,
                value: file.content,
              });
            }
            modules.push({
              name: file.path,
              type,
              content: file.content,
            });
          } else {
            if (typeof file.content !== "string") {
              return yield* new WorkerValidationError({
                message: `Expected string for ${file.path} (${type})`,
                value: file.content,
              });
            }
            modules.push({
              name: file.path,
              type,
              content: file.content,
            });
          }
        }
        return modules;
      });

      /**
       * The restart-relevant, canonically-hashable view of a local Worker's
       * desired state — `LocalProvider`'s `resolveConfig`. Everything here
       * is plain data: binding *descriptors* (not `BindingHook` closures —
       * those are materialized in `start` via {@link toRuntimeBinding}),
       * DO-namespace/hyperdrive/container-image records, bundle options.
       *
       * Queue consumers are deliberately EXCLUDED: `getQueueConsumers`
       * reads `LocalRuntimeState` at serve time and sibling `Consumer`
       * reconciles drive restarts through the `workerRestarts` hook — they
       * are runtime wiring observed at start, not desired-state config.
       */
      const resolveConfig = Effect.fn(function* ({
        id,
        news,
        bindings,
      }: LocalProvider.LocalProviderInput<Worker>) {
        const props = news as WorkerProps;
        const name = yield* createWorkerName(id, props.name);
        const compatibility = getCompatibility(props);
        const bindingDescriptors: WorkerBinding[] = [];
        const durableObjectNamespaces: Record<
          string,
          RuntimeDurableObject & { uniqueKey: string }
        > = {};
        const workflows: Record<string, RuntimeWorkflow> = {};
        const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
        const containers: Record<string, ContainerImage> = {};
        for (const { data } of bindings) {
          for (const binding of data.bindings ?? []) {
            if (
              binding.type === "durable_object_namespace" &&
              // The `durableObjectNamespaces` property is only used to declare DOs in this worker.
              // Otherwise, it's a cross-worker durable object binding, which cloudflare-runtime handles automatically.
              (!binding.scriptName || binding.scriptName === name)
            ) {
              // Reuse the existing namespace id if it was provided, otherwise generate a new one.
              // `workerd` uses this for the object's storage path, so it must be safe to use as a file name.
              const namespaceId =
                binding.namespaceId ??
                encodeURIComponent(`${name}-${binding.className}`);
              durableObjectNamespaces[binding.className] = {
                className: binding.className,
                uniqueKey: namespaceId,
                sql: true,
              };
              bindingDescriptors.push({ ...binding, namespaceId });
            } else {
              if (
                binding.type === "workflow" &&
                // Same ownership rule as DOs: only declare workflows hosted by
                // this worker. Cross-script workflow bindings are routed via
                // the registry proxy.
                (!binding.scriptName || binding.scriptName === name)
              ) {
                workflows[binding.workflowName] = {
                  workflowName: binding.workflowName,
                  className: binding.className,
                };
              }
              bindingDescriptors.push(binding);
            }
          }
          if (data.hyperdrives) {
            for (const [id, origin] of Object.entries(data.hyperdrives)) {
              hyperdrives[id] = {
                scheme: origin.scheme,
                host: origin.host,
                port: origin.port,
                user: origin.user,
                database: origin.database,
                password: unwrapRedacted(origin.password),
                sslmode: origin.sslmode,
              };
            }
          }
          if (data.containers) {
            for (const container of data.containers) {
              if (!container.dev) {
                return yield* Effect.die(
                  `Container ${container.className} has no dev image`,
                );
              }
              containers[container.className] = {
                ...container.dev,
                env: unwrapRedacted(container.dev.env),
              };
            }
          }
        }
        for (const [className, dev] of Object.entries(containers)) {
          if (!durableObjectNamespaces[className]) {
            return yield* Effect.die(
              `Durable Object namespace ${className} not found`,
            );
          }
          durableObjectNamespaces[className].container = dev;
        }
        const dev:
          | DevServerOptions
          | { readonly mode: "external"; readonly url?: string } =
          props.dev?.mode === "external"
            ? props.dev
            : {
                ...props.dev,
                mode: "worker" as const,
                // This is the default. Vite and cloudflare-runtime will retry
                // if unavailable, unless `strictPort` is true.
                port: props.dev?.port ?? 1337,
              };
        return {
          id,
          name,
          compatibility,
          /** User env (Redacted preserved — the canonical hasher unwraps). */
          env: props.env,
          /**
           * Raw inline module source (mutually exclusive with `main`).
           * Serves as-is without the bundler; part of the hashed config so
           * editing the script restarts the instance.
           */
          script: props.script,
          hasAssets: !!(props.assets || props.vite),
          bindingDescriptors,
          durableObjectNamespaces: Object.values(durableObjectNamespaces),
          workflows: Object.values(workflows),
          hyperdrives,
          vite: !!props.vite,
          viteMain: props.vite?.main,
          viteEnvironments: props.vite?.viteEnvironments,
          viteRootDir: props.vite?.rootDir,
          bundleOptions: {
            id,
            main: props.main!,
            compatibility,
            entry: props.isExternal
              ? { kind: "external" as const }
              : {
                  kind: "effect" as const,
                  exports: props.exports ?? {},
                },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          } satisfies WorkerBundleOptions,
          assets: props.assets,
          dev,
          crons: Array.from(
            new Set([...getCronBindings(bindings), ...(props.crons ?? [])]),
          ),
        };
      });

      type WorkerConfig = Effect.Success<ReturnType<typeof resolveConfig>>;
      /** A worker-mode config with its runtime `BindingHook`s materialized. */
      type RunnableWorkerConfig = Omit<WorkerConfig, "dev"> & {
        dev: DevServerOptions;
        workerBindings: BindingHook<BindingServices>[];
      };

      /**
       * Materialize the plain binding descriptors from {@link resolveConfig}
       * into live cloudflare-runtime `BindingHook`s. This is the non-plain
       * half of the old `buildConfig` — kept out of the hashed config.
       */
      const materializeWorkerBindings = Effect.fn(function* (
        config: WorkerConfig,
        selfUrl: string | undefined,
      ) {
        const { accountId } = yield* cloudflareEnv;
        // Resource-backed env entries (e.g. `env: { KV: namespace }`) are
        // represented by their binding descriptor (same name) — don't ALSO
        // serialize the resolved attributes as a duplicate json binding.
        const descriptorNames = new Set(
          config.bindingDescriptors.map((descriptor) => descriptor.name),
        );
        const workerBindings: BindingHook<BindingServices>[] = [
          Text.local("ALCHEMY_PHASE", "runtime"),
          Text.local("ALCHEMY_STACK_NAME", stack.name),
          Text.local("ALCHEMY_STAGE", stack.stage),
          Text.local("ALCHEMY_CLOUDFLARE_ACCOUNT_ID", accountId),
          ...Object.entries(config.env ?? {})
            .filter(([key]) => !descriptorNames.has(key))
            .map(([key, value]) => {
              if (isSelfUrl(value)) {
                return Text.local(key, selfUrl!);
              }
              const unredacted = Redacted.isRedacted(value)
                ? Redacted.value(value)
                : value;
              return typeof unredacted === "string"
                ? Text.local(key, unredacted)
                : Json.local(key, unredacted);
            }),
          ...(config.hasAssets ? [Assets.local("ASSETS")] : []),
        ];
        for (const descriptor of config.bindingDescriptors) {
          if (descriptor.type === "self_url") {
            // Lowered here rather than in `toRuntimeBinding` — only this
            // scope knows the worker's own dev-proxy URL.
            workerBindings.push(Text.local(descriptor.name, selfUrl!));
            continue;
          }
          workerBindings.push(yield* toRuntimeBinding(descriptor));
        }
        return workerBindings;
      });

      // Latest successful serve per worker id, so runtime wiring changes
      // that arrive AFTER workerd started (e.g. a sibling `Consumer`
      // resource registering this script as a queue consumer) can restart
      // the instance with the same bundle. `scope` is the parent scope the
      // workerd child scope is forked from (the instance scope), NOT the
      // caller's ambient scope — restarts are triggered from other
      // providers' reconcile fibers whose scopes must not own workerd.
      const latestServes = new Map<
        string,
        {
          worker: RunnableWorkerConfig;
          bundle: Bundle.BundleOutput;
          proxy: WorkerProxy.WorkerProxyInstance;
          scope: Scope.Scope;
        }
      >();
      // Serializes serves per worker id: a restart triggered by a sibling
      // resource may otherwise interleave with a rebuild-triggered serve
      // and leak a workerd scope.
      const serveLocks = new Map<string, Semaphore.Semaphore>();
      const serveLock = (id: string) => {
        let lock = serveLocks.get(id);
        if (!lock) {
          lock = Semaphore.makeUnsafe(1);
          serveLocks.set(id, lock);
        }
        return lock;
      };

      const workerdScopes = new Map<string, Scope.Closeable>();

      const serveWith = (
        worker: RunnableWorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
        parentScope: Scope.Scope,
      ) =>
        Semaphore.withPermits(
          serveLock(worker.id),
          1,
        )(
          Effect.gen(function* () {
            // Queue-consumer wiring can change while `runtime.start` is in
            // flight (a sibling `Consumer` reconcile), before the restart
            // hook below exists to pick it up. We hold the serve lock, so a
            // restart would deadlock — instead, loop and serve again until
            // the wiring is stable across a start.
            while (true) {
              const previous = workerdScopes.get(worker.id);
              if (previous) {
                // Both runtimes use the same registry key. Close the old scope first so
                // its unregister finalizer cannot delete the replacement registration.
                yield* Scope.close(previous, Exit.void);
                workerdScopes.delete(worker.id);
              }
              const queueConsumers = yield* getQueueConsumers(worker.name);
              const scope = yield* Scope.fork(parentScope);
              const url = yield* runtime
                .start({
                  name: worker.name,
                  compatibilityDate: worker.compatibility.date,
                  compatibilityFlags: worker.compatibility.flags,
                  bindings: worker.workerBindings as never,
                  hyperdrives: worker.hyperdrives,
                  durableObjectNamespaces: worker.durableObjectNamespaces,
                  workflows: worker.workflows,
                  queueConsumers,
                  // Cache API opt-out (`dev: { cache: false }`) — matches
                  // production workers.dev, where the Cache API is a no-op.
                  cache: worker.dev.cache,
                  // Per-worker request.cf override (`dev: { cf: {...} }`).
                  cf: worker.dev.cf,
                  modules: yield* toRuntimeModules(bundle),
                  assets: yield* toRuntimeAssets(worker.assets),
                })
                .pipe(Scope.provide(scope));
              workerdScopes.set(worker.id, scope);
              latestServes.set(worker.id, {
                worker,
                bundle,
                proxy,
                scope: parentScope,
              });
              // Register the restart hook before the re-check below: changes
              // landing after the re-check find the hook; changes before it
              // are caught by the re-check. Nothing falls in between.
              MutableHashMap.set(
                localRuntimeState.workerRestarts,
                worker.name,
                restartWorker(worker.id),
              );
              const currentConsumers = yield* getQueueConsumers(worker.name);
              if (
                JSON.stringify(currentConsumers) !==
                JSON.stringify(queueConsumers)
              ) {
                // Wiring changed while workerd was starting — serve again with
                // the fresh consumers before exposing the instance.
                continue;
              }
              yield* proxy.set(url);
              return url;
            }
          }),
        );

      const serveScoped = Effect.fn(function* (
        worker: RunnableWorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
      ) {
        const parentScope = yield* Effect.scope;
        return yield* serveWith(worker, bundle, proxy, parentScope);
      });

      /**
       * Restart a running worker with its latest bundle so start-time
       * runtime wiring (queue consumers) is re-read from
       * {@link LocalRuntimeState}. No-op if the worker hasn't served yet —
       * the pending first serve will already observe the updated state.
       */
      const restartWorker = (id: string) =>
        Effect.suspend(() => {
          const latest = latestServes.get(id);
          if (!latest) return Effect.void;
          return serveWith(
            latest.worker,
            latest.bundle,
            latest.proxy,
            latest.scope,
          ).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `[${id}] Failed to restart local worker`,
                Cause.squash(cause),
              ),
            ),
          );
        });

      // Note: `serveLocks` entries are intentionally retained — an
      // in-flight restart may still hold the semaphore when the instance
      // is torn down, and a same-id re-create must serialize against it.
      const dropServeState = (id: string) => {
        const latest = latestServes.get(id);
        if (latest) {
          MutableHashMap.remove(
            localRuntimeState.workerRestarts,
            latest.worker.name,
          );
          latestServes.delete(id);
        }
      };

      const runWorker = Effect.fn(function* (worker: RunnableWorkerConfig) {
        let start = Date.now();
        let status: "start" | "update" = "start";
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        // Inline `script` workers bypass the bundler entirely — the string
        // IS the module (mirroring the deploy path, which uploads it as a
        // single `main.js`). There is nothing to watch: script changes flow
        // through the hashed config and restart the instance.
        if (worker.script !== undefined) {
          yield* serveScoped(
            worker,
            {
              files: [{ path: "main.js", content: worker.script, hash: "" }],
              hash: "",
            },
            proxy,
          );
          yield* Effect.log(
            `[${worker.id}] Started in ${Math.round(Date.now() - start)}ms`,
          );
          return proxy.url;
        }
        yield* (
          isPythonMain(worker.bundleOptions.main)
            ? watchPythonWorkerBundle({
                id: worker.bundleOptions.id,
                main: worker.bundleOptions.main,
                compatibility: worker.compatibility,
              })
            : bundler.watch(worker.bundleOptions)
        ).pipe(
          Stream.tap((event) => {
            if (event._tag === "Start") {
              start = Date.now();
              if (status === "update") {
                return Effect.all([
                  Effect.log(`[${worker.id}] Rebuilding`),
                  // This tells the proxy to queue requests until the updated worker is ready.
                  Effect.forkChild(proxy.unset()),
                ]);
              }
            } else if (event._tag === "Error") {
              return Effect.logError(
                `[${worker.id}] Bundle error`,
                event.error,
              );
            }
            return Effect.void;
          }),
          Stream.filterMap((event) =>
            event._tag === "Success"
              ? Result.succeed(event.output)
              : Result.failVoid,
          ),
          Stream.mapEffect((bundle) =>
            serveScoped(worker, bundle, proxy).pipe(
              Effect.exit,
              Effect.tap((exit) => {
                if (exit._tag === "Success") {
                  const message = Effect.log(
                    `[${worker.id}] ${status === "update" ? "Updated" : "Started"} in ${Math.round(Date.now() - start)}ms`,
                  );
                  status = "update";
                  return message;
                } else {
                  return Effect.logError(
                    `[${worker.id}] Error`,
                    Cause.squash(exit.cause),
                  );
                }
              }),
            ),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        );
        return proxy.url;
      });

      const runVite = Effect.fn(function* (
        worker: RunnableWorkerConfig,
        rootDir: string | undefined,
      ) {
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        yield* proxy.unset().pipe(Effect.forkChild);
        // Loaded lazily: `./Vite.ts` pulls in `@distilled.cloud/cloudflare-vite-plugin`
        // (~0.5s); only needed when running a vite dev server.
        const Vite = yield* Effect.promise(() => import("./Vite.ts"));
        const devServer = yield* Vite.viteDev(
          rootDir,
          worker.env ?? {},
          {
            main: worker.viteMain,
            compatibilityDate: worker.compatibility.date,
            compatibilityFlags: worker.compatibility.flags,
            viteEnvironments: worker.viteEnvironments,
            worker: {
              name: worker.name,
              bindings: worker.workerBindings,
              durableObjectNamespaces: worker.durableObjectNamespaces,
              workflows: worker.workflows,
              hyperdrives: worker.hyperdrives,
              queueConsumers: yield* getQueueConsumers(worker.name),
              assets: yield* toRuntimeAssets(worker.assets),
            },
            context,
          },
          { port: 0 },
        );
        yield* proxy.set(new URL(devServer.resolvedUrls!.local[0]));
        return proxy.url;
      });

      return {
        resolveConfig,

        // The physical name only survives an update when it isn't changing.
        stables: ({ output, config }) =>
          Effect.succeed(
            output?.workerName === config.name
              ? (["workerName"] as ["workerName"])
              : undefined,
          ),

        precreate: Effect.fn(function* ({ id, news, bindings }) {
          const name = yield* createWorkerName(id, news.name);
          const durableObjectNamespaces: Record<string, string> = {};
          for (const { data } of bindings) {
            for (const binding of data?.bindings ?? []) {
              if (binding.type === "durable_object_namespace") {
                durableObjectNamespaces[binding.className] =
                  binding.namespaceId ??
                  encodeURIComponent(
                    `${binding.scriptName!}-${binding.className}`,
                  );
              }
            }
          }
          const { accountId } = yield* cloudflareEnv;
          const url =
            news.dev?.mode === "external"
              ? // news.dev.url may be an unresolved output; avoid trying to resolve it here.
                undefined
              : yield* maybeStartProxy(id, {
                  ...news.dev,
                  mode: "worker" as const,
                  port: news.dev?.port ?? 1337,
                }).pipe(Effect.map((proxy) => proxy.url.toString()));
          return {
            workerId: name,
            workerName: name,
            namespace: undefined,
            logpush: undefined,
            url,
            tags: [],
            durableObjectNamespaces,
            domains: url ? [url] : [],
            routes: [],
            crons: Array.from(
              new Set([...getCronBindings(bindings), ...(news.crons ?? [])]),
            ),
            accountId,
          };
        }),

        start: Effect.fn(function* ({ id, config }) {
          const { accountId } = yield* cloudflareEnv;

          // `dev: { mode: "external" }` opts out of running a local Worker
          // entirely — typically because an external dev process
          // (Command.Dev) is serving requests. The instance exists in the
          // registry (with an empty scope) but has no workerd behind it. A
          // previous worker-mode instance for this id may have registered
          // serve/restart state — drop it (its workerd died with the old
          // instance scope the helper just closed).
          if (config.dev.mode === "external") {
            dropServeState(id);
            return {
              workerId: config.name,
              workerName: config.name,
              namespace: undefined,
              logpush: undefined,
              url: config.dev.url,
              tags: [],
              durableObjectNamespaces: {},
              accountId,
              domains: [],
              routes: [],
              crons: config.crons,
            } satisfies Worker["Attributes"];
          }

          // `Worker.URL` locally resolves to the worker's dev-proxy URL —
          // the proxy is stable per worker id (the same instance `runWorker`
          // / `runVite` attach to below), so the URL is known before workerd
          // starts. Trailing slash stripped to match the cloud value's shape.
          const needsSelfUrl =
            config.bindingDescriptors.some((b) => b.type === "self_url") ||
            Object.values(config.env ?? {}).some(isSelfUrl);
          const selfUrl = needsSelfUrl
            ? (yield* maybeStartProxy(id, config.dev)).url
                .toString()
                .replace(/\/$/, "")
            : undefined;
          const workerBindings = yield* materializeWorkerBindings(
            config,
            selfUrl,
          );
          const worker: RunnableWorkerConfig = {
            ...config,
            // Substitute `Worker.URL` sentinels so the Vite dev server
            // inlines the local URL into VITE_*-prefixed define entries.
            env:
              config.env && selfUrl !== undefined
                ? Object.fromEntries(
                    Object.entries(config.env).map(([key, value]) => [
                      key,
                      isSelfUrl(value) ? selfUrl : value,
                    ]),
                  )
                : config.env,
            dev: config.dev,
            workerBindings,
          };
          const url = yield* (
            config.vite
              ? runVite(worker, config.viteRootDir)
              : runWorker(worker)
          ).pipe(Effect.map((url) => url.toString()));
          return {
            workerId: config.name,
            workerName: config.name,
            namespace: undefined,
            logpush: undefined,
            url,
            tags: [],
            durableObjectNamespaces: Object.fromEntries(
              config.durableObjectNamespaces.map((namespace) => [
                namespace.className,
                namespace.uniqueKey,
              ]),
            ),
            domains: [url],
            routes: [],
            crons: config.crons,
            accountId,
          } satisfies Worker["Attributes"];
        }),

        stop: Effect.fn(function* ({ id }) {
          // Cross-restart state: the serve/restart bookkeeping and the URL
          // proxy live outside instance scopes (they survive restarts) and
          // are only reclaimed on a real delete.
          dropServeState(id);
          yield* stopProxy(id);
        }),
      } satisfies LocalProvider.LocalProviderSpec<
        Worker,
        Effect.Success<ReturnType<typeof resolveConfig>>,
        // The Python-bundle watcher spawns `uv` (ChildProcessSpawner) and
        // reads vendored modules (FileSystem) from inside `start`;
        // `readAssetsConfigFiles` (assets `_headers`/`_redirects`) needs
        // FileSystem + Path.
        | ChildProcessSpawner.ChildProcessSpawner
        | FileSystem.FileSystem
        | Path.Path
      >;
    }),
  );

export const toRuntimeBinding = Effect.fn(function* (b: WorkerBinding) {
  const unsupported = () =>
    new WorkerValidationError({
      message: `${b.type} bindings are not supported in local mode`,
      value: b,
    });
  switch (b.type) {
    case "ai":
      return Ai.remote(b.name);
    case "ai_search":
      return AiSearch.remote(b.name, b.instanceName);
    case "ai_search_namespace":
      return AiSearch.remoteNamespace(b.name, b.namespace);
    case "analytics_engine":
      return AnalyticsEngine.local(b.name, b.dataset);
    case "artifacts":
      return Artifacts.remote(b.name, b.namespace);
    case "assets":
      return Assets.local(b.name);
    case "browser":
      return Browser.remote(b.name);
    case "d1":
      // A `dev:` id belongs to a locally-emulated database (local D1
      // provider); a real id is a live database the dev worker proxies to
      // (e.g. the resource opted out of emulation via `Alchemy.live()`).
      return isLocalId(b.databaseId)
        ? D1.local({ binding: b.name, id: b.databaseId })
        : D1.remote(b.name, b.databaseId);
    case "data_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "dispatch_namespace":
      return DispatchNamespace.remote({
        binding: b.name,
        namespace: b.namespace,
      });
    case "durable_object_namespace":
      return DurableObjectNamespace.local({
        binding: b.name,
        className: b.className,
        scriptName: b.scriptName,
        uniqueKey:
          b.namespaceId ??
          encodeURIComponent(`${b.scriptName!}-${b.className}`),
      });
    case "flagship":
      return Flagship.remote(b.name, b.appId);
    case "hyperdrive":
      return Hyperdrive.local(b.name, b.id);
    case "images":
      return Images.remote(b.name);
    case "inherit":
      return yield* unsupported();
    case "json":
      return Json.local(b.name, b.json);
    case "kv_namespace":
      // A `dev:` id belongs to a locally-emulated namespace; a real id is
      // a live namespace the dev worker proxies to.
      return isLocalId(b.namespaceId)
        ? KvNamespace.local({ binding: b.name, id: b.namespaceId })
        : KvNamespace.remote(b.name, b.namespaceId);
    case "mtls_certificate":
      return MtlsCertificate.remote(b.name, b.certificateId);
    case "pipelines":
      return Pipelines.remote(b.name, b.pipeline);
    case "plain_text":
      return Text.local(b.name, b.text);
    case "queue":
      // A real queueId belongs to an `Alchemy.live()` queue. Queue bindings
      // are NOT supported in Cloudflare's remote/preview sessions — a
      // platform limitation, not an alchemy one: an edge-preview worker
      // with a queue binding serves 503 for every request, wrangler's
      // remote bindings exclude Queues, and `wrangler dev --remote` rejects
      // them outright (cloudflare/workers-sdk#9929). Fail the deploy loudly
      // instead of wiring a binding that breaks on first send.
      if (b.queueId !== undefined && !isLocalId(b.queueId)) {
        return yield* new WorkerValidationError({
          message:
            `Queue binding "${b.name}" targets a live queue (Alchemy.live()) — ` +
            "Cloudflare's remote-binding sessions do not support Queues " +
            "(see cloudflare/workers-sdk#9929), so a live queue cannot be " +
            "produced to from local dev. Remove live() from the queue " +
            "(local emulation), or run the whole stack live (alchemy deploy).",
          value: b,
        });
      }
      return Queue.local({
        binding: b.name,
        queueName: b.queueName,
      });
    case "r2_bucket":
      // A `dev:`-prefixed bucket name belongs to a locally-emulated bucket
      // (R2 has no opaque id — the name is the identity); a real name is a
      // live bucket the dev worker proxies to.
      return isLocalId(b.bucketName)
        ? R2Bucket.local({ binding: b.name, id: b.bucketName })
        : R2Bucket.remote(b.name, b.bucketName, b.jurisdiction);
    case "ratelimit":
      return RateLimit.local({
        binding: b.name,
        simple: b.simple,
        namespaceId: b.namespaceId,
      });
    case "secret_key":
      return yield* unsupported();
    case "secret_text":
      return Text.local(b.name, b.text);
    case "secrets_store_secret":
      return yield* unsupported();
    case "send_email":
      return SendEmail.remote({
        binding: b.name,
        destinationAddress: b.destinationAddress,
        allowedDestinationAddresses: b.allowedDestinationAddresses,
        allowedSenderAddresses: b.allowedSenderAddresses,
      });
    case "service":
      return Service.local({
        binding: b.name,
        scriptName: b.service,
        entrypoint: b.entrypoint,
      });
    case "text_blob":
      return Data.local(b.name, Buffer.from(b.part));
    case "vectorize":
      return Vectorize.remote(b.name, b.indexName);
    case "version_metadata":
      return VersionMetadata.local(b.name);
    case "wasm_module":
      return WasmModule.local(b.name, Buffer.from(b.part));
    case "worker_loader":
      return WorkerLoader.local(b.name);
    case "workflow":
      return Workflows.local({
        binding: b.name,
        workflowName: b.workflowName,
        className: b.className,
        scriptName: b.scriptName,
      });
    default:
      return yield* unsupported();
  }
});

const toRuntimeAssets = Effect.fn(function* (
  assets: WorkerAssetsConfig | undefined,
) {
  if (!assets) return undefined;
  // Mirror the deploy path: the special `_headers` / `_redirects` files
  // in the assets directory carry the rules unless overridden by
  // explicit `headers` / `redirects` props. The local runtime parses
  // the raw string contents just like Cloudflare does.
  //
  // A Vite website's `assets` is config-only (`{ runWorkerFirst: true }`) —
  // the client output directory is the build's business, and in `dev` the
  // vite plugin serves assets from the dev server, so there is no directory
  // to read here.
  const directory: string | undefined =
    typeof assets === "string" ? assets : assets.directory;
  // An unreadable file just means no rules here — the assets plugin
  // reports directory problems itself.
  const files = yield* readAssetsConfigFiles(directory).pipe(
    Effect.orElseSucceed(() => ({
      _headers: undefined,
      _redirects: undefined,
    })),
  );
  if (typeof assets === "string") {
    return {
      directory: assets,
      headers: files._headers,
      redirects: files._redirects,
    };
  }
  return {
    directory: assets.directory,
    headers: assets.headers ?? files._headers,
    redirects: assets.redirects ?? files._redirects,
    // Distilled widened generated string enums to open unions (`string & {}`);
    // the API only ever returns the known variants here.
    htmlHandling: assets.htmlHandling as
      | "none"
      | "auto-trailing-slash"
      | "force-trailing-slash"
      | "drop-trailing-slash"
      | undefined,
    notFoundHandling: assets.notFoundHandling as
      | "none"
      | "404-page"
      | "single-page-application"
      | undefined,
    runWorkerFirst: assets.runWorkerFirst,
    serveDirectly: assets.serveDirectly,
  };
});

const moduleTypeFromExtension = (ext: string): Module["type"] | "SourceMap" => {
  switch (ext) {
    case ".wasm":
      return "Wasm";
    case ".txt":
    case ".html":
    case ".sql":
    case ".custom":
      return "Text";
    case ".bin":
      return "Data";
    case ".mjs":
    case ".js":
      return "ESModule";
    case ".cjs":
      return "CommonJsModule";
    case ".py":
      return "PythonModule";
    case ".map":
      return "SourceMap";
    default:
      return "Text";
  }
};
