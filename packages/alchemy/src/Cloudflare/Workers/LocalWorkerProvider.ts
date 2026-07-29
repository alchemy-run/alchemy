import {
  Runtime,
  RuntimeError,
  type BindingHook,
  type BindingServices,
  type HyperdriveOrigin,
  type Module,
  type Assets as RuntimeAssets,
  type DurableObjectNamespace as RuntimeDurableObject,
  type QueueConsumer as RuntimeQueueConsumer,
  type Workflow as RuntimeWorkflow,
  type RuntimeServices,
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
import * as Fiber from "effect/Fiber";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as os from "node:os";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved, stripEffects } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { sha256, unwrapRedacted } from "../../Util/index.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { LOCAL_ENTRY_URL, LocalRuntimeState } from "../LocalRuntime.ts";
import type { WorkerAssetsConfig, WorkerProps } from "../Workers/Worker.ts";
import { readAssetsConfigFiles } from "./Assets.ts";
import { getCompatibility } from "./Compatibility.ts";
import { isPythonMain, watchPythonWorkerBundle } from "./PythonWorkerBundle.ts";
import { isSelfUrl, Worker } from "./Worker.ts";
import { getCronBindings } from "./WorkerAsyncBindings.ts";
import type { WorkerBinding } from "./WorkerBinding.ts";
import { WorkerBundle, type WorkerBundleOptions } from "./WorkerBundle.ts";
import { createWorkerName } from "./WorkerName.ts";

type WorkerPropsWithDev = Omit<WorkerProps, "dev"> & {
  dev: Extract<WorkerProps["dev"], { mode?: "worker" }>;
};

/**
 * The normalized dev-server options a proxy is started with (`props.dev`
 * with the default port applied). Named independently of `WorkerConfig` so
 * `maybeStartProxy` — which `buildConfig` now calls to resolve `Worker.URL`
 * — doesn't form a type cycle through `WorkerConfig["dev"]`.
 */
type DevServerOptions = WorkerPropsWithDev["dev"] & { port: number };

// Hosts that bind every interface — the dev server is then reachable at
// `localhost` *and* at each LAN address, like Vite's `--host` output.
const isWildcardHost = (host: string) =>
  host === "0.0.0.0" || host === "::" || host === "[::]" || host === "*";

/**
 * Resolve every URL a local dev server is reachable at, most relevant
 * first. A loopback or explicit host yields just that URL; a wildcard host
 * (`0.0.0.0`, `::`) yields `http://localhost:<port>` followed by one URL
 * per external IPv4 interface (`http://192.168.0.12:<port>`, ...) —
 * mirroring Vite's "Local / Network" dev-server output.
 */
const resolveLocalUrls = (serverUrl: URL): Effect.Effect<string[]> =>
  Effect.sync(() => {
    const port = serverUrl.port;
    const host = serverUrl.hostname;
    if (!isWildcardHost(host)) {
      return [serverUrl.origin];
    }
    // `os.networkInterfaces()` is a sync, CPU-only syscall with no Effect
    // platform equivalent — wrapped in `Effect.sync` so it participates in
    // the runtime.
    const interfaces = os.networkInterfaces();
    const lanAddresses = Object.values(interfaces)
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === "IPv4" && !address.internal)
      .map((address) => address.address);
    return [
      `http://localhost:${port}`,
      ...lanAddresses.map((address) => `http://${address}:${port}`),
    ];
  });

export class WorkerValidationError extends Schema.TaggedErrorClass<WorkerValidationError>()(
  "WorkerValidationError",
  {
    message: Schema.String,
    hint: Schema.optional(Schema.String),
    value: Schema.Unknown,
  },
) {}

export const LocalWorkerProvider = () =>
  RpcProvider.effect(
    Worker,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      const runtime = yield* Runtime;
      const stack = yield* Stack;
      const path = yield* Path.Path;
      const localRuntimeState = yield* LocalRuntimeState;
      const workerProxy = yield* WorkerProxy.WorkerProxy;
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

      // Latest successful serve per worker id, so runtime wiring changes
      // that arrive AFTER workerd started (e.g. a sibling `Consumer`
      // resource registering this script as a queue consumer) can restart
      // the instance with the same bundle.
      const latestServes = new Map<
        string,
        {
          worker: WorkerConfig;
          bundle: Bundle.BundleOutput;
          proxy: WorkerProxy.WorkerProxyInstance;
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

      // Serve with make-before-break semantics: start the replacement
      // workerd while the previous instance (if any) keeps serving — and
      // stays registered in the dev registry — then cut the proxy over and
      // tear the previous instance down. Cross-script consumers (e.g. a DO
      // bound via `scriptName` from another Worker) therefore never observe
      // a window where the script has no running instance and no registry
      // entry, even when `runtime.start` is slow (container image builds).
      // Both instances use the same registry key; the registry's entry
      // removal is owner-aware, so closing the old scope after the
      // replacement has re-registered cannot delete the replacement's
      // registration.
      //
      // The workerd scope is forked from the provider's `rootScope`, NOT
      // the instance scope: a reconcile that replaces the instance (or a
      // restart triggered from a sibling provider's fiber) tears down the
      // bundle watcher without killing the currently serving workerd — the
      // last good instance keeps serving until the replacement's first
      // serve completes. Ownership is tracked in `workerdScopes`, closed by
      // the next successful serve, by `delete`, or by provider shutdown.
      const serveWith = (
        worker: WorkerConfig,
        bundle: Bundle.BundleOutput,
        proxy: WorkerProxy.WorkerProxyInstance,
      ) =>
        Semaphore.withPermits(
          serveLock(worker.id),
          1,
        )(
          // The bookkeeping around `runtime.start` must not be torn in half
          // by an interrupt: once a replacement workerd is up, it must be
          // recorded in `workerdScopes` and the superseded instances must be
          // closed, or one of the workerds would leak until provider
          // shutdown while holding the shared registry key.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const previous = workerdScopes.get(worker.id);
              // Instances whose queue-consumer wiring went stale while they
              // were starting; never exposed via the proxy, closed together
              // with `previous` after the cutover below.
              const superseded: Scope.Closeable[] = [];
              let scope!: Scope.Closeable;
              let url!: URL;
              // Queue-consumer wiring can change while `runtime.start` is in
              // flight (a sibling `Consumer` reconcile), before the restart
              // hook below exists to pick it up. We hold the serve lock, so a
              // restart would deadlock — instead, loop and serve again until
              // the wiring is stable across a start.
              while (true) {
                const queueConsumers = yield* getQueueConsumers(worker.name);
                scope = yield* Scope.fork(rootScope);
                url = yield* restore(
                  runtime
                    .start({
                      name: worker.name,
                      compatibilityDate: worker.compatibility.date,
                      compatibilityFlags: worker.compatibility.flags,
                      bindings: worker.workerBindings as never,
                      hyperdrives: worker.hyperdrives,
                      durableObjectNamespaces: worker.durableObjectNamespaces,
                      workflows: worker.workflows,
                      queueConsumers,
                      modules: yield* toRuntimeModules(bundle),
                      assets: yield* toRuntimeAssets(worker.assets),
                    })
                    .pipe(Scope.provide(scope)),
                ).pipe(
                  // The scope hangs off `rootScope`, so a failed or
                  // interrupted start must close it here — nothing else owns
                  // it yet.
                  Effect.onExit((exit) =>
                    exit._tag === "Failure"
                      ? Scope.close(scope, exit)
                      : Effect.void,
                  ),
                );
                workerdScopes.set(worker.id, scope);
                latestServes.set(worker.id, { worker, bundle, proxy });
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
                  // Wiring changed while workerd was starting — serve again
                  // with the fresh consumers before exposing the instance.
                  superseded.push(scope);
                  continue;
                }
                break;
              }
              yield* proxy.set(url);
              // Only now tear the replaced instances down: `previous` kept
              // serving — and stayed registered in the dev registry — until
              // the cutover above. The registry's entry removal is
              // owner-aware, so these closes cannot delete the replacement's
              // registration.
              for (const replaced of previous
                ? [...superseded, previous]
                : superseded) {
                yield* Scope.close(replaced, Exit.void).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      `[${worker.id}] Failed to stop previous local worker instance`,
                      Cause.squash(cause),
                    ),
                  ),
                );
              }
              return url;
            }),
          ),
        );

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
          return serveWith(latest.worker, latest.bundle, latest.proxy).pipe(
            Effect.asVoid,
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `[${id}] Failed to restart local worker`,
                Cause.squash(cause),
              ),
            ),
          );
        });

      // Tear down the running workerd for a worker id, if any. Used when the
      // Worker is deleted or handed off to an external dev process —
      // instance replacement does NOT go through this: the previous workerd
      // keeps serving until the replacement's first serve closes it.
      const closeWorkerd = Effect.fn(function* (id: string) {
        const scope = workerdScopes.get(id);
        if (scope) {
          workerdScopes.delete(id);
          yield* Scope.close(scope, Exit.void);
        }
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

      const buildConfig = Effect.fn(function* ({
        id,
        props,
        bindings,
      }: {
        id: string;
        props: WorkerPropsWithDev;
        bindings: ResourceBinding<Worker["Binding"]>[];
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = yield* createWorkerName(id, props.name);
        const compatibility = getCompatibility(props);
        const dev: DevServerOptions = {
          ...props.dev,
          // This is the default. Vite and cloudflare-runtime will retry if unavailable, unless `strictPort` is true.
          port: props.dev?.port ?? 1337,
        };
        // `Worker.URL` locally resolves to the worker's dev-proxy URL — the
        // proxy is stable per worker id (the same instance `runWorker` /
        // `runVite` attach to below), so the URL is known before workerd
        // starts. Trailing slash stripped to match the cloud value's shape.
        const needsSelfUrl =
          bindings.some((b) =>
            (b.data.bindings ?? []).some((item) => item.type === "self_url"),
          ) || Object.values(props.env ?? {}).some(isSelfUrl);
        const selfUrl = needsSelfUrl
          ? (yield* maybeStartProxy(id, dev)).url.toString().replace(/\/$/, "")
          : undefined;
        const workerBindings: BindingHook<BindingServices>[] = [
          Text.local("ALCHEMY_PHASE", "runtime"),
          Text.local("ALCHEMY_WORKER_NAME", name),
          Text.local("ALCHEMY_STACK_NAME", stack.name),
          Text.local("ALCHEMY_STAGE", stack.stage),
          Text.local("ALCHEMY_CLOUDFLARE_ACCOUNT_ID", accountId),
          ...Object.entries(props.env ?? {}).map(([key, value]) => {
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
          ...(props.assets || props.vite ? [Assets.local("ASSETS")] : []),
        ];
        const durableObjectNamespaces: Record<
          string,
          RuntimeDurableObject & { uniqueKey: string }
        > = {};
        const workflows: Record<string, RuntimeWorkflow> = {};
        const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
        const containers: Record<string, ContainerImage> = {};
        for (const { data } of bindings) {
          for (const binding of data.bindings ?? []) {
            if (binding.type === "self_url") {
              // Lowered here rather than in `toRuntimeBinding` — only this
              // scope knows the worker's own dev-proxy URL.
              workerBindings.push(Text.local(binding.name, selfUrl!));
              continue;
            }
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
              workerBindings.push(
                yield* toRuntimeBinding({
                  ...binding,
                  namespaceId,
                }),
              );
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
              workerBindings.push(yield* toRuntimeBinding(binding));
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
        return {
          id,
          name,
          compatibility,
          workerBindings,
          durableObjectNamespaces: Object.values(durableObjectNamespaces),
          workflows: Object.values(workflows),
          // Relative `vite.main` resolves from the Vite root (see the
          // matching normalization in WorkerProvider's `viteBuild`).
          viteMain: props.vite?.main
            ? path.resolve(props.vite.rootDir ?? process.cwd(), props.vite.main)
            : undefined,
          viteEnvironments: props.vite?.viteEnvironments,
          hyperdrives,
          // Substitute `Worker.URL` sentinels so the Vite dev server inlines
          // the local URL into VITE_*-prefixed define entries.
          env:
            props.env && selfUrl !== undefined
              ? Object.fromEntries(
                  Object.entries(props.env).map(([key, value]) => [
                    key,
                    isSelfUrl(value) ? selfUrl : value,
                  ]),
                )
              : props.env,
          bundleOptions: {
            id,
            main: props.main!,
            compatibility,
            entry: props.isExternal
              ? { kind: "external" }
              : { kind: "effect", exports: props.exports ?? {} },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: props.build,
          } satisfies WorkerBundleOptions,
          assets: props.assets,
          dev,
        };
      });

      type WorkerConfig = Effect.Success<ReturnType<typeof buildConfig>>;

      const runWorker = Effect.fn(function* (worker: WorkerConfig) {
        let start = Date.now();
        let status: "start" | "update" = "start";
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
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
            serveWith(worker, bundle, proxy).pipe(
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

      // Assets-only Worker: there is no entry module to bundle or watch.
      // The local runtime requires a user worker module, so serve a stub
      // that delegates every request to the ASSETS binding — the assets
      // worker applies `htmlHandling` / `notFoundHandling` (including SPA
      // fallback) itself, matching Cloudflare's deployed assets-only
      // behavior.
      const assetsOnlyBundle: Bundle.BundleOutput = {
        files: [
          {
            path: "main.js",
            content:
              "export default { fetch: (request, env) => env.ASSETS.fetch(request) };",
            hash: "assets-only-stub",
          },
        ],
        hash: "assets-only-stub",
      };

      const runAssetsOnly = Effect.fn(function* (worker: WorkerConfig) {
        const start = Date.now();
        const proxy = yield* maybeStartProxy(worker.id, worker.dev);
        yield* serveWith(worker, assetsOnlyBundle, proxy);
        yield* Effect.log(
          `[${worker.id}] Started in ${Math.round(Date.now() - start)}ms`,
        );
        return proxy.url;
      });

      const runVite = Effect.fn(function* (
        worker: WorkerConfig,
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

      const rootScope = yield* Effect.scope;
      const workerdScopes = new Map<string, Scope.Closeable>();

      const context = yield* Effect.context<RuntimeServices>();
      const instances = new Map<
        string,
        {
          signature: string;
          fiber: Fiber.Fiber<
            Worker["Attributes"],
            Bundle.BundleError | WorkerValidationError | RuntimeError
          >;
          scope: Scope.Closeable;
        }
      >();

      const runInstance = Effect.fn(function* (options: {
        id: string;
        props: WorkerPropsWithDev;
        bindings: ResourceBinding<Worker["Binding"]>[];
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const { props, bindings } = options;
        const config = yield* buildConfig(options);
        const serverUrl = yield* props.vite
          ? runVite(config, props.vite.rootDir)
          : props.main === undefined && props.assets
            ? runAssetsOnly(config)
            : runWorker(config);
        // In dev, `urls` is the dev server's actual surface — localhost
        // first, then LAN addresses for wildcard hosts. Deployed domains
        // are not served by this session, so they don't appear.
        const urls = yield* resolveLocalUrls(serverUrl);
        return {
          workerId: config.name,
          workerName: config.name,
          namespace: undefined,
          logpush: undefined,
          url: urls[0],
          urls,
          domain: undefined,
          tags: [],
          durableObjectNamespaces: Object.fromEntries(
            config.durableObjectNamespaces.map((namespace) => [
              namespace.className,
              namespace.uniqueKey,
            ]),
          ),
          routes: [],
          crons: Array.from(
            new Set([...getCronBindings(bindings), ...(props.crons ?? [])]),
          ),
          accountId,
        } satisfies Worker["Attributes"];
      });

      return {
        // Local dev provider: there is no cloud enumeration API. The set of
        // locally running Workers is the in-memory `instances` map; each
        // instance's fiber resolves to the Worker Attributes once it has
        // started, so enumerate that local state.
        list: () =>
          Effect.forEach(
            Array.from(instances.values()),
            (instance) => Fiber.join(instance.fiber),
            { concurrency: "unbounded" },
          ),
        diff: Effect.fn(function* ({ id, news: desired, newBindings, output }) {
          // Effect-valued `env` entries (tagged Worker classes) never resolve
          // at plan time; their identity is carried by the resolved binding
          // data. Strip them so the signature-based diff still runs — same
          // rationale as the cloud WorkerProvider (#874).
          const news = stripEffects(desired);
          if (!isResolved(news) || !isResolved(newBindings)) return undefined;
          const options = {
            id,
            props: news,
            bindings: newBindings,
          };
          const signature = yield* structuralSignature(options);
          if (instances.get(options.id)?.signature === signature) {
            return { action: "noop" };
          }
          const name = yield* createWorkerName(id, news.name);
          return {
            action: "update",
            stables: output?.workerName === name ? ["workerName"] : undefined,
          };
        }),
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
          const { accountId } = yield* yield* CloudflareEnvironment;
          const urls =
            news.dev?.mode === "external"
              ? // news.dev.url may be an unresolved output; avoid trying to resolve it here.
                []
              : yield* maybeStartProxy(id, {
                  ...news.dev,
                  port: news.dev?.port ?? 1337,
                }).pipe(Effect.flatMap((proxy) => resolveLocalUrls(proxy.url)));
          return {
            workerId: name,
            workerName: name,
            namespace: undefined,
            logpush: undefined,
            url: urls[0],
            urls,
            domain: undefined,
            tags: [],
            durableObjectNamespaces,
            routes: [],
            crons: Array.from(
              new Set([...getCronBindings(bindings), ...(news.crons ?? [])]),
            ),
            accountId,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, bindings }) {
          // `dev: false` opts out of running a local Worker entirely —
          // typically because an external dev process (DevCommand) is
          // serving requests. Tear down any prior instance and return a
          // stub Attributes; the resource exists in state but has no
          // running workerd / proxy behind it.
          if (news.dev?.mode === "external") {
            const { accountId } = yield* yield* CloudflareEnvironment;
            const existing = instances.get(id);
            if (existing) {
              yield* Fiber.interrupt(existing.fiber);
              yield* Scope.close(existing.scope, Exit.void);
              instances.delete(id);
              dropServeState(id);
            }
            yield* closeWorkerd(id);
            const name = yield* createWorkerName(id, news.name);
            const urls = news.dev.url ? [news.dev.url] : [];
            return {
              workerId: name,
              workerName: name,
              namespace: undefined,
              logpush: undefined,
              url: urls[0],
              urls,
              domain: undefined,
              tags: [],
              durableObjectNamespaces: {},
              accountId,
              routes: [],
              crons: news.crons ?? [],
            } satisfies Worker["Attributes"];
          }
          const options = { id, props: news as WorkerPropsWithDev, bindings };
          const signature = yield* structuralSignature(options);
          const existing = instances.get(options.id);
          if (existing) {
            if (existing.signature === signature) {
              yield* Effect.log(
                `[${options.id}] No changes, using existing instance`,
              );
              return yield* Fiber.join(existing.fiber);
            }
            yield* Effect.log(
              `[${options.id}] Changes detected, interrupting existing instance`,
            );
            // Tears down the instance's bundle watcher and any in-flight
            // serve — but NOT its running workerd, which keeps serving (and
            // stays registered in the dev registry) until the replacement
            // instance's first serve completes and cuts over.
            yield* Fiber.interrupt(existing.fiber);
            yield* Scope.close(existing.scope, Exit.void);
            instances.delete(options.id);
            dropServeState(options.id);
          }
          const scope = yield* Scope.fork(rootScope);
          const fiber = yield* runInstance(options).pipe(
            Effect.forkDetach,
            Scope.provide(scope),
          );
          instances.set(options.id, { signature, fiber, scope });
          return yield* Fiber.join(fiber).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (exit._tag === "Failure") {
                  instances.delete(options.id);
                }
              }),
            ),
          );
        }),
        delete: Effect.fn(function* ({ id }) {
          const existing = instances.get(id);
          if (existing) {
            yield* Fiber.interrupt(existing.fiber);
            yield* Scope.close(existing.scope, Exit.void);
            instances.delete(id);
            dropServeState(id);
          }
          yield* closeWorkerd(id);
        }),
      };
    }),
  );

export const toRuntimeBinding = Effect.fn(function* (
  b: WorkerBinding,
  dev?: { remote?: boolean },
) {
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
      return D1.remote(b.name, b.databaseId);
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
      return KvNamespace.remote(b.name, b.namespaceId);
    case "mtls_certificate":
      return MtlsCertificate.remote(b.name, b.certificateId);
    case "pipelines":
      return Pipelines.remote(b.name, b.pipeline);
    case "plain_text":
      return Text.local(b.name, b.text);
    case "queue":
      return Queue.local({
        binding: b.name,
        queueName: b.queueName,
      });
    case "r2_bucket":
      return R2Bucket.remote(b.name, b.bucketName, b.jurisdiction);
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
      return SendEmail[dev?.remote ? "remote" : "local"]({
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

/**
 * Stable, collision-free structural signature used to decide whether a
 * locally-running dev Worker needs to be torn down and restarted.
 *
 * We deliberately do NOT use `Hash.structure` here: Effect's structural
 * hash folds sibling fields together with XOR, so when the *same* value
 * change appears in two sibling subtrees the diffs cancel and the hash is
 * unchanged. The Worker config mirrors `env` values into `bindings`
 * (e.g. `DEV_MARKER`/an R2 bucket name appear in both `props.env` and the
 * derived `bindings`), which is exactly the shape that collides — so an
 * env-only or rebind change would be silently treated as "no change" and
 * the dev Worker would never restart with the new bindings.
 *
 * A canonical JSON serialization (sorted keys, unwrapped `Redacted`,
 * cycle-safe) gives an exact comparison instead of a lossy fingerprint. We
 * hash that serialization with SHA-256 so each retained signature is a fixed
 * 64-char digest rather than a copy of the whole props/bindings blob.
 */
const structuralSignature = (value: unknown): Effect.Effect<string> => {
  const seen = new WeakSet<object>();
  const normalize = (input: unknown): unknown => {
    if (typeof input === "bigint") return `bigint:${input.toString()}`;
    if (input === null || typeof input !== "object") return input;
    if (Redacted.isRedacted(input)) {
      return { __redacted: normalize(Redacted.value(input)) };
    }
    if (seen.has(input)) return "[circular]";
    seen.add(input);
    if (input instanceof Uint8Array) return { __bytes: Array.from(input) };
    if (Array.isArray(input)) return input.map(normalize);
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [
          key,
          normalize((input as Record<string, unknown>)[key]),
        ]),
    );
  };
  return sha256(JSON.stringify(normalize(value)));
};

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
