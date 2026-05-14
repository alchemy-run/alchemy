import {
  Runtime,
  type BindingHook,
  type BindingServices,
  type HyperdriveOrigin,
  type Module,
  type Assets as RuntimeAssets,
  type DurableObjectNamespace as RuntimeDurableObjectNamespace,
  type RuntimeServices,
} from "@distilled.cloud/cloudflare-runtime";
import {
  Ai,
  Assets,
  Browser,
  D1,
  Data,
  DurableObjectNamespace,
  Hyperdrive,
  Images,
  Json,
  KvNamespace,
  R2Bucket,
  Service,
  Text,
  VersionMetadata,
  WasmModule,
  WorkerLoader,
} from "@distilled.cloud/cloudflare-runtime/bindings";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { getCompatibility } from "../Workers/Compatibility.ts";
import { getCronBindings } from "../Workers/index.ts";
import * as Vite from "../Workers/Vite.ts";
import type {
  Worker,
  WorkerAssetsConfig,
  WorkerBinding,
} from "../Workers/Worker.ts";
import {
  WorkerBundle,
  type WorkerBundleOptions,
} from "../Workers/WorkerBundle.ts";
import {
  ServeError,
  ServeResult,
  Sidecar,
  ValidationError,
  type ReconcileOptions,
} from "./Sidecar.ts";

export const SidecarHandlers = Layer.effect(
  Sidecar,
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    const bundler = yield* WorkerBundle;
    const runtime = yield* Runtime;
    const path = yield* Path.Path;

    const toRuntimeModules = Effect.fn(function* (bundle: Bundle.BundleOutput) {
      const modules: Module[] = [];
      for (const file of bundle.files) {
        const ext = path.extname(file.path);
        const type = moduleTypeFromExtension(ext);
        if (type === "SourceMap") continue;
        if (type === "Data" || type === "Wasm") {
          if (!(file.content instanceof Uint8Array)) {
            return yield* new ValidationError({
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
            return yield* new ValidationError({
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

    const serveScoped = Effect.fnUntraced(function* (
      worker: WorkerConfig,
      bundle: Bundle.BundleOutput,
    ) {
      const scope = yield* Effect.flatMap(Effect.scope, Scope.fork);
      const result = yield* runtime
        .start({
          name: worker.name,
          compatibilityDate: worker.compatibility.date,
          compatibilityFlags: worker.compatibility.flags,
          bindings: worker.workerBindings as never,
          hyperdrives: worker.hyperdrives,
          durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
            worker.durableObjectNamespaces,
          ),
          modules: yield* toRuntimeModules(bundle),
          assets: toRuntimeAssets(worker.assets),
        })
        .pipe(Scope.provide(scope));
      const previous = workerdScopes.get(worker.id);
      if (previous) {
        yield* Effect.forkDetach(Scope.close(previous, Exit.void));
      }
      workerdScopes.set(worker.id, scope);
      return result;
    });

    const buildConfig = Effect.fn(function* ({
      id,
      props,
      bindings,
      stack,
    }: ReconcileOptions) {
      const name = id.toLowerCase();
      const compatibility = getCompatibility(props);
      const workerBindings: BindingHook<BindingServices>[] = [];
      const durableObjectNamespaces: Record<string, string> = {};
      const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
      for (const { data } of bindings) {
        for (const binding of data.bindings ?? []) {
          if (binding.type === "durable_object_namespace") {
            durableObjectNamespaces[binding.name] = binding.className!;
          }
          workerBindings.push(yield* toRuntimeBinding(binding));
        }
        if (data.hyperdrives) {
          for (const [id, origin] of Object.entries(data.hyperdrives)) {
            hyperdrives[id] = {
              scheme: origin.scheme,
              host: origin.host,
              port: origin.port,
              user: origin.user,
              database: origin.database,
              password: Redacted.isRedacted(origin.password)
                ? Redacted.value(origin.password)
                : origin.password,
              sslmode: origin.sslmode,
            };
          }
        }
      }
      for (const [key, value] of Object.entries(props.env ?? {})) {
        if (value === undefined) continue;
        if (Redacted.isRedacted(value)) {
          workerBindings.push(Text.binding(key, Redacted.value(value)));
        } else if (typeof value === "string") {
          workerBindings.push(Text.binding(key, value));
        } else {
          workerBindings.push(Json.binding(key, value));
        }
      }
      return {
        id,
        name,
        compatibility,
        workerBindings,
        durableObjectNamespaces,
        hyperdrives,
        bundleOptions: {
          id,
          main: props.main,
          compatibility,
          entry: props.isExternal
            ? { kind: "external" }
            : { kind: "effect", exports: (props.exports ?? {}) as any },
          stack: { name: stack.name, stage: stack.stage },
          userOptions: props.build,
        } satisfies WorkerBundleOptions,
        assets: props.assets,
      };
    });

    type WorkerConfig = Effect.Success<ReturnType<typeof buildConfig>>;

    const runServer = Effect.fnUntraced(function* (worker: WorkerConfig) {
      const addressResult = yield* Deferred.make<string, ServeError>();
      let start = Date.now();
      yield* bundler.watch(worker.bundleOptions).pipe(
        Stream.mapEffect((event) =>
          event._tag === "Error" && !Deferred.isDoneUnsafe(addressResult)
            ? Effect.fail(event.error)
            : Effect.succeed(event),
        ),
        Stream.tap((event) => {
          if (event._tag === "Start") {
            start = Date.now();
            if (Deferred.isDoneUnsafe(addressResult)) {
              return Effect.log(`[${worker.name}] Rebuilding`);
            }
          } else if (event._tag === "Error") {
            return Effect.logError(
              `[${worker.name}] Bundle error`,
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
          serveScoped(worker, bundle).pipe(
            Effect.exit,
            Effect.tap((exit) => {
              const isDone = Deferred.isDoneUnsafe(addressResult);
              if (exit._tag === "Success") {
                return Effect.log(
                  `[${worker.id}] ${isDone ? "Updated" : "Started"} in ${Math.round(Date.now() - start)}ms`,
                );
              } else {
                return Effect.logError(
                  `[${worker.id}] Error`,
                  Cause.squash(exit.cause),
                );
              }
            }),
            Effect.tap((exit) => Deferred.complete(addressResult, exit)),
          ),
        ),
        Stream.onExit((exit) =>
          exit._tag === "Failure" && !Deferred.isDoneUnsafe(addressResult)
            ? Deferred.failCause(addressResult, exit.cause)
            : Effect.void,
        ),
        Stream.runDrain,
        Effect.forkScoped,
      );
      return yield* Deferred.await(addressResult).pipe(
        Effect.map((address) => `http://${address}`),
      );
    });

    const rootScope = yield* Effect.scope;
    const workerdScopes = new Map<string, Scope.Closeable>();

    const context = yield* Effect.context<RuntimeServices>();
    const instances = new Map<
      string,
      {
        hash: number;
        fiber: Fiber.Fiber<ServeResult, ServeError>;
        scope: Scope.Closeable;
      }
    >();

    const runInstance = Effect.fn(function* (options: ReconcileOptions) {
      const config = yield* buildConfig(options);
      let address: string;
      if (options.props.vite) {
        console.log("starting vite dev server", options.id);
        const devServer = yield* Vite.viteDev(options.props.vite.rootDir, {
          compatibilityDate: config.compatibility.date,
          compatibilityFlags: config.compatibility.flags,
          bindings: config.workerBindings,
          durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
            config.durableObjectNamespaces,
          ),
          context,
        });
        console.log("vite dev server started", options.id);
        address = devServer.resolvedUrls!.local[0];
      } else if (!options.props.isExternal) {
        // HACK: `runServer` fails with Effect workers right now.
        // The failure occurs in `serveScoped` - `runtime.start` fails because the `stdin` pipe is broken.
        // It shows up as a generic RuntimeError, but I was able to trace it down to one of:
        // - kj/io.c++:351: failed: miniposix::read(fd, pos, max - pos): Device not configured; fd = 0
        // - EPIPE: broken pipe, send
        // This only occurs when it's an Effect worker and `serveScoped` is called after a watcher event.
        // I need to figure out a better solution, but in the meantime, this is our workaround, and
        // it should be safe (albeit slower) because the CLI watches Effect workers anyway.
        const bundle = yield* bundler.build(config.bundleOptions);
        address = yield* serveScoped(config, bundle);
      } else {
        address = yield* runServer(config);
      }
      return {
        workerId: config.name,
        workerName: config.name,
        logpush: undefined,
        url: address,
        tags: [],
        durableObjectNamespaces: config.durableObjectNamespaces,
        domains: [],
        crons: Array.from(
          new Set([
            ...getCronBindings(options.bindings),
            ...(options.props.crons ?? []),
          ]),
        ),
        accountId,
      } satisfies Worker["Attributes"];
    });

    return Sidecar.of({
      diff: Effect.fn(function* (options) {
        const hash = Hash.structure(options);
        return {
          action:
            // The props.isExternal check is a workaround for the Effect worker issue (see `runInstance` for more details).
            // Remove it once the issue is fixed.
            instances.get(options.id)?.hash === hash && options.props.isExternal
              ? "noop"
              : "update",
        };
      }),
      reconcile: Effect.fn(function* (options) {
        const hash = Hash.structure(options);
        const existing = instances.get(options.id);
        if (existing) {
          // The props.isExternal check is a workaround for the Effect worker issue (see `runInstance` for more details).
          // Remove it once the issue is fixed.
          if (existing.hash === hash && options.props.isExternal) {
            yield* Effect.log(
              `[${options.id}] No changes, using existing instance`,
            );
            return yield* Fiber.join(existing.fiber);
          }
          yield* Effect.log(
            `[${options.id}] Changes detected, interrupting existing instance`,
          );
          yield* Fiber.interrupt(existing.fiber);
          yield* Scope.close(existing.scope, Exit.void);
          instances.delete(options.id);
        }
        const scope = yield* Scope.fork(rootScope);
        const fiber = yield* runInstance(options).pipe(
          Effect.forkDetach,
          Scope.provide(scope),
        );
        instances.set(options.id, { hash, fiber, scope });
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
      delete: Effect.fn(function* (id) {
        const existing = instances.get(id);
        if (existing) {
          yield* Fiber.interrupt(existing.fiber);
          yield* Scope.close(existing.scope, Exit.void);
          instances.delete(id);
        }
      }),
    });
  }),
);

const toRuntimeBinding = Effect.fnUntraced(function* (b: WorkerBinding) {
  const unsupported = () =>
    new ValidationError({
      message: `${b.type} bindings are not supported in local mode`,
      value: b,
    });
  switch (b.type) {
    case "ai":
      return Ai.remote(b.name);
    case "analytics_engine":
      return yield* unsupported();
    case "artifacts":
      return yield* unsupported();
    case "assets":
      return Assets.binding(b.name);
    case "browser":
      return Browser.binding(b.name);
    case "d1":
      return D1.remote(b.name, b.id);
    case "data_blob":
      return Data.binding(b.name, Buffer.from(b.part));
    case "dispatch_namespace":
      return yield* unsupported();
    case "durable_object_namespace":
      return DurableObjectNamespace.local({
        name: b.name,
        className: b.className!,
        scriptName: b.scriptName,
      });
    case "hyperdrive":
      return Hyperdrive.binding(b.name, b.id);
    case "images":
      return Images.remote(b.name);
    case "inherit":
      return yield* unsupported();
    case "json":
      return Json.binding(b.name, b.json);
    case "kv_namespace":
      return KvNamespace.remote(b.name, b.namespaceId);
    case "mtls_certificate":
      return yield* unsupported();
    case "pipelines":
      return yield* unsupported();
    case "plain_text":
      return Text.binding(b.name, b.text);
    case "queue":
      return yield* unsupported();
    case "r2_bucket":
      return R2Bucket.remote(b.name, b.bucketName, b.jurisdiction);
    case "ratelimit":
      return yield* unsupported();
    case "secret_key":
      return yield* unsupported();
    case "secret_text":
      return Text.binding(b.name, b.text);
    case "secrets_store_secret":
      return yield* unsupported();
    case "send_email":
      return yield* unsupported();
    case "service":
      return Service.local({ name: b.name, scriptName: b.service });
    case "text_blob":
      return Data.binding(b.name, Buffer.from(b.part));
    case "vectorize":
      return yield* unsupported();
    case "version_metadata":
      return VersionMetadata.binding(b.name);
    case "wasm_module":
      return WasmModule.binding(b.name, Buffer.from(b.part));
    case "worker_loader":
      return WorkerLoader.binding(b.name);
    case "workflow":
      return yield* unsupported();
    default:
      return yield* unsupported();
  }
});

const toRuntimeAssets = (
  assets: WorkerAssetsConfig | undefined,
): RuntimeAssets | undefined => {
  if (!assets) return undefined;
  if (typeof assets === "string") {
    return {
      directory: assets,
    };
  }
  return {
    directory: "directory" in assets ? assets.directory : assets.path,
    headers: assets.config?.headers,
    redirects: assets.config?.redirects,
    htmlHandling: assets.config?.htmlHandling,
    notFoundHandling: assets.config?.notFoundHandling,
    runWorkerFirst: assets.config?.runWorkerFirst,
    serveDirectly: assets.config?.serveDirectly,
  };
};

const toRuntimeDurableObjectNamespaces = (
  namespaces: Record<string, string>,
): RuntimeDurableObjectNamespace[] => {
  return Object.entries(namespaces).map(([className, namespaceId]) => ({
    className,
    uniqueKey: namespaceId,
    sql: true,
  }));
};

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
    case ".map":
      return "SourceMap";
    default:
      return "Text";
  }
};
