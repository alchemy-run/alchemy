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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { flow } from "effect/Function";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
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
import { Sidecar, ValidationError, type ReconcileOptions } from "./Sidecar.ts";

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
        serve: flow(
          toRuntimeModules,
          Effect.flatMap((modules) =>
            runtime.start({
              name,
              compatibilityDate: compatibility.date,
              compatibilityFlags: compatibility.flags,
              bindings: workerBindings as BindingHook<never>[],
              modules,
              assets: toRuntimeAssets(props.assets),
              hyperdrives,
              durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
                durableObjectNamespaces,
              ),
            }),
          ),
        ),
      };
    });

    const rootScope = yield* Effect.scope;
    const serverScopes = new Map<string, Scope.Closeable>();

    const hashes = new Map<string, number>();
    const context = yield* Effect.context<RuntimeServices>();

    return Sidecar.of({
      diff: Effect.fn(function* (options) {
        const hash = Hash.structure(options);
        return {
          action: hashes.get(options.id) === hash ? "noop" : "update",
        };
      }),
      reconcile: Effect.fn(function* (options) {
        const config = yield* buildConfig(options);
        const previousScope = serverScopes.get(options.id);
        if (previousScope) {
          yield* Scope.close(previousScope, Exit.void);
          serverScopes.delete(options.id);
        }
        const newScope = yield* Scope.fork(rootScope);
        let address: string;
        if (options.props.vite) {
          const devServer = yield* Vite.viteDev(options.props.vite.rootDir, {
            compatibilityDate: config.compatibility.date,
            compatibilityFlags: config.compatibility.flags,
            bindings: config.workerBindings,
            durableObjectNamespaces: toRuntimeDurableObjectNamespaces(
              config.durableObjectNamespaces,
            ),
            context,
          }).pipe(Scope.provide(newScope));
          address = devServer.resolvedUrls!.local[0];
        } else {
          const bundle = yield* bundler.build(config.bundleOptions);
          address = yield* config.serve(bundle).pipe(Scope.provide(newScope));
        }
        serverScopes.set(options.id, newScope);
        hashes.set(options.id, Hash.structure(options));
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
      }),
      delete: Effect.fn(function* (id) {
        const previousScope = serverScopes.get(id);
        if (previousScope) {
          yield* Scope.close(previousScope, Exit.void);
          serverScopes.delete(id);
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
      return DurableObjectNamespace.local(b.name, b.className!);
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
      return Service.remote(b.name, b.service);
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
