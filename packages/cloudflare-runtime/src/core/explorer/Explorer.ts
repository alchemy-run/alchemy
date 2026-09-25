import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { fileURLToPath } from "node:url";
import { SERVICE_D1 } from "../bindings/d1/D1Options.shared.ts";
import { SERVICE_KV } from "../bindings/kv-namespace/KvNamespaceOptions.shared.ts";
import { SERVICE_R2 } from "../bindings/r2-bucket/R2BucketOptions.shared.ts";
import {
  WORKFLOWS_STORAGE_DIRECTORY,
  WORKFLOWS_WRAPPED_BINDING_MODULE,
} from "../bindings/workflows/Workflows.ts";
import { SERVICE_EXPLORER } from "../globals/EntryOptions.shared.ts";
import * as Loopback from "../globals/Loopback.ts";
import * as Storage from "../globals/Storage.ts";
import {
  defaultDurableObjectUniqueKey,
  SERVICE_USER_WORKER,
} from "../internal/constants.ts";
import * as Registry from "../registry/Registry.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type { RuntimeWorker } from "../RuntimeWorker.ts";
import * as WorkerdConfig from "../workerd/Config.ts";

/**
 * Miniflare's Local Explorer (`/cdn-cgi/explorer`): a UI + REST API for
 * browsing and editing a worker's local KV, D1, R2, Durable Object and
 * Workflow state.
 *
 * The explorer worker, its UI and the Durable Object introspection wrapper
 * are Miniflare's prebuilt artifacts, copied into `dist/core/explorer` at
 * build time (`scripts/copy-explorer.ts`). This module supplies the contract
 * they expect from Miniflare's host: the `LOCAL_EXPLORER_BINDING_MAP` of
 * resource id → binding, the bindings themselves, and the Node-side loopback
 * routes (`/core/dev-registry`, `/core/do-storage`, `/core/workflow-storage`).
 */
export class Explorer extends Context.Service<
  Explorer,
  {
    /**
     * Services to add to the worker's workerd config, and the user modules
     * with every SQLite-backed Durable Object class wrapped for introspection.
     */
    readonly make: (
      worker: RuntimeWorker,
      bindings: ReadonlyArray<WorkerdConfig.Worker_Binding>,
      modules: Array<WorkerdConfig.Worker_Module>,
    ) => Effect.Effect<
      {
        services: Array<WorkerdConfig.Service>;
        modules: Array<WorkerdConfig.Worker_Module>;
      },
      ConfigError
    >;
  }
>()("cloudflare-runtime/Explorer") {}

const SERVICE_EXPLORER_UI = "explorer:ui";
const LOOPBACK_TARGET_EXPLORER = "explorer";
// The explorer titles KV namespaces and D1 databases by the last `:` segment
// of their binding name, so the user's binding name goes last.
const BINDING_PREFIX = "EXPLORER";

// Miniflare-internal names baked into the prebuilt explorer / wrapper.
const DO_WRAPPER_ENTRY = "__mf_do_wrapper_entry.js";
const DO_WRAPPER = "__mf_do_wrapper.js";

interface BindingMap {
  kv: Record<string, string>;
  d1: Record<string, string>;
  r2: Record<string, string>;
  do: Record<
    string,
    {
      className: string;
      scriptName: string;
      useSQLite: boolean;
      binding: string;
    }
  >;
  workflows: Record<
    string,
    {
      name: string;
      className: string;
      scriptName: string;
      binding: string;
      engineBinding: string;
    }
  >;
}

interface WorkerOpts {
  kv: Array<{ id: string; bindingName: string }>;
  d1: Array<{ id: string; bindingName: string }>;
  r2: Array<{ id: string; bindingName: string }>;
  do: Array<{
    id: string;
    bindingName: string;
    className: string;
    scriptName: string;
    useSqlite: boolean;
  }>;
  workflows: Array<{
    id: string;
    bindingName: string;
    className: string;
    scriptName: string;
  }>;
}

const designatorProps = (
  designator: WorkerdConfig.ServiceDesignator | undefined,
  service: string,
): Record<string, string> | undefined =>
  designator?.name === service && designator.props
    ? JSON.parse(designator.props.json)
    : undefined;

/**
 * Pick out the worker's local KV / D1 / R2 bindings. Remote bindings target
 * other services and are skipped — the explorer only shows local state.
 */
const localResource = (
  binding: WorkerdConfig.Worker_Binding,
): { kind: "kv" | "d1" | "r2"; id: string } | undefined => {
  if ("kvNamespace" in binding) {
    const id = designatorProps(binding.kvNamespace, SERVICE_KV)?.namespaceId;
    return id === undefined ? undefined : { kind: "kv", id };
  }
  if ("r2Bucket" in binding) {
    const id = designatorProps(binding.r2Bucket, SERVICE_R2)?.bucketName;
    return id === undefined ? undefined : { kind: "r2", id };
  }
  if (
    "wrapped" in binding &&
    binding.wrapped?.moduleName === "cloudflare-internal:d1-api"
  ) {
    const inner = binding.wrapped.innerBindings?.[0];
    const id =
      inner && "service" in inner
        ? designatorProps(inner.service, SERVICE_D1)?.databaseId
        : undefined;
    return id === undefined ? undefined : { kind: "d1", id };
  }
  return undefined;
};

const wrapperEntry = (entry: string, classNames: ReadonlyArray<string>) =>
  [
    `import { createDurableObjectWrapper } from "./${DO_WRAPPER}";`,
    `import * as __mf_original__ from "./${entry}";`,
    `export * from "./${entry}";`,
    `export default __mf_original__.default;`,
    ...classNames.map(
      (className) =>
        `export const ${className} = createDurableObjectWrapper(__mf_original__.${className});`,
    ),
  ].join("\n");

export const ExplorerLive = Layer.effect(
  Explorer,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const storage = yield* Storage.Storage;
    const registry = yield* Registry.Registry;
    const loopback = yield* Loopback.Loopback;
    if (Effect.isEffect(loopback)) {
      return yield* Effect.die("Expected loopback to be initialized");
    }
    const storageDirectory = "disk" in storage ? storage.disk?.path : undefined;

    const assets = yield* Effect.cached(
      Effect.gen(function* () {
        const missing = (name: string, cause?: unknown) =>
          new ConfigError({
            subtag: "ExplorerAssetsMissing",
            message: `Local Explorer asset "${name}" not found.`,
            hint: "Build @alchemy.run/cloudflare-runtime (`bun run build`), which copies the explorer from Miniflare into dist/core/explorer.",
            cause,
          });
        const resolve = (name: string) =>
          Effect.gen(function* () {
            const file = yield* Effect.try({
              try: () =>
                fileURLToPath(
                  import.meta.resolve(`#cloudflare-runtime-explorer/${name}`),
                ),
              catch: (cause) => missing(name, cause),
            });
            const exists = yield* fs
              .exists(file)
              .pipe(Effect.orElseSucceed(() => false));
            return exists ? file : yield* missing(name);
          });
        const read = (name: string) =>
          resolve(name).pipe(
            Effect.flatMap((file) => fs.readFileString(file)),
            Effect.mapError(
              (cause) =>
                new ConfigError({
                  subtag: "ExplorerAssetsMissing",
                  message: `Failed to read Local Explorer asset "${name}".`,
                  cause,
                }),
            ),
          );
        const [worker, doWrapper, uiIndex] = yield* Effect.all(
          [
            read("explorer.worker.js"),
            read("do-wrapper.worker.js"),
            resolve("ui/index.html"),
          ],
          { concurrency: "unbounded" },
        );
        return { worker, doWrapper, uiDirectory: path.dirname(uiIndex) };
      }),
    );

    // Resolve `<base>/<name>` and refuse anything that escapes `base`.
    const within = (base: string, name: string) => {
      const resolved = path.resolve(base, name);
      return resolved.startsWith(path.resolve(base) + path.sep)
        ? resolved
        : undefined;
    };

    const listDirectory = (directory: string) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(directory))) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const names = yield* fs.readDirectory(directory);
        const entries = yield* Effect.forEach(
          names,
          (name) =>
            fs.stat(path.join(directory, name)).pipe(
              Effect.map((info) => ({
                name,
                type: info.type === "Directory" ? "directory" : "file",
                birthtimeMs: Option.match(info.birthtime, {
                  onNone: () => 0,
                  onSome: (date) => date.getTime(),
                }),
              })),
            ),
          { concurrency: "unbounded" },
        );
        return yield* HttpServerResponse.json(entries);
      });

    const SQLITE_EXTENSIONS = [".sqlite", ".sqlite-shm", ".sqlite-wal"];

    const deleteWorkflowInstances = (
      directory: string,
      hexId: string | undefined,
    ) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(directory))) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const names = hexId
          ? SQLITE_EXTENSIONS.map((ext) => `${hexId}${ext}`)
          : (yield* fs.readDirectory(directory)).filter((name) =>
              SQLITE_EXTENSIONS.some((ext) => name.endsWith(ext)),
            );
        let deleted = false;
        for (const name of names) {
          const file = within(directory, name);
          if (!file) {
            return HttpServerResponse.text("Invalid instance ID", {
              status: 400,
            });
          }
          if (yield* fs.exists(file)) {
            yield* fs.remove(file);
            if (name.endsWith(".sqlite")) deleted = true;
          }
        }
        return hexId && !deleted
          ? HttpServerResponse.text("Not Found", { status: 404 })
          : HttpServerResponse.empty({ status: 200 });
      });

    // Miniflare's loopback endpoints used by the explorer worker.
    const loopbackService = yield* loopback.api.route(
      LOOPBACK_TARGET_EXPLORER,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const { pathname } = new URL(request.url, "http://localhost");
        if (pathname === "/core/dev-registry") {
          const entries = yield* registry.list;
          return yield* HttpServerResponse.json(
            Object.fromEntries(
              entries.map((entry) => [
                entry.scriptName,
                { debugPortAddress: entry.debugPortAddress },
              ]),
            ),
          );
        }
        if (storageDirectory === undefined) {
          return HttpServerResponse.text("Storage is not disk-backed", {
            status: 404,
          });
        }
        const [, , kind, name, hexId] = pathname
          .split("/")
          .map(decodeURIComponent);
        if (kind === "do-storage" && name) {
          // workerd stores `<localDisk>/<uniqueKey>/<objectId>.sqlite`.
          const directory = within(storageDirectory, name);
          return directory
            ? yield* listDirectory(directory)
            : HttpServerResponse.text("Invalid namespace ID", { status: 400 });
        }
        if (kind === "workflow-storage" && name) {
          // Engines are keyed by `encodeURIComponent(workflowName)`.
          const base = path.join(storageDirectory, WORKFLOWS_STORAGE_DIRECTORY);
          const directory = within(base, encodeURIComponent(name));
          if (!directory) {
            return HttpServerResponse.text("Invalid workflow name", {
              status: 400,
            });
          }
          return request.method === "DELETE"
            ? yield* deleteWorkflowInstances(directory, hexId)
            : yield* listDirectory(directory);
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }),
    );

    return Explorer.of({
      make: Effect.fn(function* (worker, bindings, modules) {
        const {
          worker: explorerWorker,
          doWrapper,
          uiDirectory,
        } = yield* assets;
        const map: BindingMap = {
          kv: {},
          d1: {},
          r2: {},
          do: {},
          workflows: {},
        };
        const opts: WorkerOpts = {
          kv: [],
          d1: [],
          r2: [],
          do: [],
          workflows: [],
        };
        const explorerBindings: Array<WorkerdConfig.Worker_Binding> = [];

        for (const binding of bindings) {
          const resource = localResource(binding);
          if (!resource || !binding.name) continue;
          const name = `${BINDING_PREFIX}:${resource.kind}:${binding.name}`;
          map[resource.kind][resource.id] = name;
          opts[resource.kind].push({
            id: resource.id,
            bindingName: binding.name,
          });
          explorerBindings.push({ ...binding, name });
        }

        const sqlClasses: Array<string> = [];
        for (const namespace of worker.durableObjectNamespaces ?? []) {
          // In-memory namespaces have nothing on disk to browse.
          if (namespace.ephemeralLocal) continue;
          const uniqueKey =
            namespace.uniqueKey ??
            defaultDurableObjectUniqueKey(worker.name, namespace.className);
          const binding = `EXPLORER_DO_${uniqueKey}`;
          map.do[uniqueKey] = {
            className: namespace.className,
            scriptName: worker.name,
            useSQLite: namespace.sql,
            binding,
          };
          opts.do.push({
            id: uniqueKey,
            bindingName: namespace.className,
            className: namespace.className,
            scriptName: worker.name,
            useSqlite: namespace.sql,
          });
          explorerBindings.push({
            name: binding,
            durableObjectNamespace: {
              className: namespace.className,
              serviceName: SERVICE_USER_WORKER,
            },
          });
          if (namespace.sql) sqlClasses.push(namespace.className);
        }

        for (const workflow of worker.workflows ?? []) {
          const engineService = `workflows:${workflow.workflowName}`;
          const binding = `${BINDING_PREFIX}:workflows:${workflow.workflowName}`;
          const engineBinding = `EXPLORER_WORKFLOW_ENGINE_${workflow.workflowName}`;
          map.workflows[workflow.workflowName] = {
            name: workflow.workflowName,
            className: workflow.className,
            scriptName: worker.name,
            binding,
            engineBinding,
          };
          opts.workflows.push({
            id: workflow.workflowName,
            bindingName: workflow.workflowName,
            className: workflow.className,
            scriptName: worker.name,
          });
          explorerBindings.push(
            {
              name: binding,
              wrapped: {
                moduleName: WORKFLOWS_WRAPPED_BINDING_MODULE,
                innerBindings: [
                  {
                    name: "binding",
                    service: {
                      name: engineService,
                      entrypoint: "WorkflowBinding",
                    },
                  },
                ],
              },
            },
            {
              name: engineBinding,
              durableObjectNamespace: {
                className: "Engine",
                serviceName: engineService,
              },
            },
          );
        }

        // Add `__miniflare_introspectSqlite` / `__miniflare_getDOName` to
        // SQLite-backed Durable Object classes by re-exporting them through
        // Miniflare's wrapper from a new main module.
        const [entry] = modules;
        const wrappedModules =
          sqlClasses.length > 0 && entry && "esModule" in entry
            ? [
                {
                  name: DO_WRAPPER_ENTRY,
                  esModule: wrapperEntry(entry.name, sqlClasses),
                },
                { name: DO_WRAPPER, esModule: doWrapper },
                ...modules,
              ]
            : modules;

        return {
          modules: wrappedModules,
          services: [
            {
              name: SERVICE_EXPLORER_UI,
              disk: { path: uiDirectory, writable: false },
            },
            {
              name: SERVICE_EXPLORER,
              worker: {
                compatibilityDate: "2026-01-01",
                compatibilityFlags: ["nodejs_compat"],
                modules: [
                  { name: "explorer.worker.js", esModule: explorerWorker },
                ],
                bindings: [
                  ...explorerBindings,
                  {
                    name: "LOCAL_EXPLORER_BINDING_MAP",
                    json: JSON.stringify(map),
                  },
                  {
                    name: "MINIFLARE_EXPLORER_DISK",
                    service: { name: SERVICE_EXPLORER_UI },
                  },
                  { name: "MINIFLARE_LOOPBACK", service: loopbackService },
                  {
                    name: "LOCAL_EXPLORER_WORKER_NAMES",
                    json: JSON.stringify([worker.name]),
                  },
                  {
                    name: "MINIFLARE_EXPLORER_WORKER_OPTS",
                    json: JSON.stringify({ [worker.name]: opts }),
                  },
                  // Never phone home from local development.
                  {
                    name: "MINIFLARE_TELEMETRY_CONFIG",
                    json: JSON.stringify({ enabled: false }),
                  },
                  // Dials peer explorers for cross-process aggregation.
                  {
                    name: "DEV_REGISTRY_DEBUG_PORT",
                    workerdDebugPort: WorkerdConfig.kVoid,
                  },
                ],
              },
            },
          ],
        };
      }),
    });
  }),
);
