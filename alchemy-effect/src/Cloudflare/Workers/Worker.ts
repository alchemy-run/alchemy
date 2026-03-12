import type * as cf from "@cloudflare/workers-types";
import {
  Bundle,
  type Module as BundledModule,
} from "@distilled.cloud/cloudflare-bundler";
import * as workers from "@distilled.cloud/cloudflare/workers";
import type { Workers } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/index.ts";
import { DotAlchemy } from "../../Config.ts";
import {
  Host,
  type ListenHandler,
  type ServerlessExecutionContext,
} from "../../Host.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { sha256 } from "../../Util/sha256.ts";
import { Account } from "../Account.ts";
import * as Assets from "./Assets.ts";
import type { DurableObjectState } from "./DurableObject.ts";

export const isWorker = <T>(value: T): value is T & Worker => {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "Cloudflare.Worker"
  );
};

export class WorkerEnvironment extends ServiceMap.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  cf.ExecutionContext
>()("Cloudflare.Workers.ExecutionContext") {}

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.Workers.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.Workers.WorkerEvent";

export type WorkerProps = {
  /**
   * Worker name override. If omitted, Alchemy derives a deterministic physical
   * name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Static assets to serve. Can be:
   * - A string path to the assets directory
   * - An AssetsProps object with directory and config
   * - An object with path and hash (e.g., from a Build resource)
   */
  assets?:
    | string
    | Worker.AssetsProps
    | Worker.AssetsWithHash
    | (Worker.AssetsWithHash & { [K: string]: any });
  logpush?: boolean;
  observability?: Worker.Observability;
  subdomain?: Worker.Subdomain;
  tags?: string[];
  main: string;
  compatibility?: {
    date?: string;
    flags?: string[];
  };
  limits?: Worker.Limits;
  placement?: Worker.Placement;
  env?: Record<string, any>;
  exports?: string[];
};

export interface WorkerExecutionContext extends ServerlessExecutionContext {
  export(name: string, value: any): Effect.Effect<void>;
}

export interface Worker extends Resource<
  "Cloudflare.Workers.Worker",
  WorkerProps,
  {
    workerId: string;
    workerName: string;
    logpush: boolean | undefined;
    url: string | undefined;
    tags: string[] | undefined;
    accountId: string;
    hash?: {
      assets: string | undefined;
      bundle: string;
    };
  },
  {
    bindings: Worker.Binding[];
  }
> {}

/**
 * A Cloudflare Worker host with deploy-time binding support and runtime export
 * collection.
 *
 * `Worker` behaves like a resource during deploy, but it also carries a runtime
 * execution context so KV, R2, Durable Objects, assets, and service bindings
 * can be inferred from the worker program itself.
 *
 * @section Creating Workers
 * @example Basic Worker
 * ```typescript
 * const worker = yield* Worker("ApiWorker", {
 *   main: "./src/worker.ts",
 * });
 * ```
 */
export const Worker = Host<
  Worker,
  WorkerExecutionContext,
  DurableObjectState | WorkerEnvironment | ExecutionContext
>("Cloudflare.Workers.Worker", (id: string) => {
  const listeners: Effect.Effect<ListenHandler>[] = [];
  const exports: Record<string, any> = {};
  const env: Record<string, any> = {};

  return {
    type: "Cloudflare.Workers.Worker",
    id,
    run: undefined!,
    env,
    get: (key: string) =>
      Effect.serviceOption(WorkerEnvironment).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.flatMap((env) =>
          env
            ? Effect.succeed(env[key])
            : Effect.die("WorkerEnvironment not found"),
        ),
        Effect.flatMap((value) =>
          value
            ? Effect.succeed(value)
            : Effect.die(`Environment variable '${key}' not found`),
        ),
      ) as any,
    set: (id: string, output: Output.Output) =>
      Effect.sync(() => {
        const key = id.replaceAll(/[^a-zA-Z0-9]/g, "_");
        env[key] = output.pipe(Output.map((value) => JSON.stringify(value)));
        return key;
      }),
    listen: ((handler: ListenHandler | Effect.Effect<ListenHandler>) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as ServerlessExecutionContext["listen"],
    export: (name: string, value: any) =>
      Effect.gen(function* () {
        if (name in exports) {
          return yield* Effect.die(
            new Error(`Worker export '${name}' already exists`),
          );
        }
        exports[name] = value;
      }),
    exports: Effect.gen(function* () {
      const handlers = yield* Effect.all(listeners, {
        concurrency: "unbounded",
      });
      const handle =
        (type: WorkerEvent["type"]) =>
        (request: any, env: unknown, context: cf.ExecutionContext) => {
          const event: WorkerEvent = {
            kind: "Cloudflare.Workers.WorkerEvent",
            type,
            input: request,
            env,
            context,
          };
          for (const handler of handlers) {
            const eff = handler(event);
            if (Effect.isEffect(eff)) {
              return eff.pipe(
                Effect.provideService(ExecutionContext, context),
                Effect.provideService(
                  WorkerEnvironment,
                  env as Record<string, any>,
                ),
                Effect.runPromise,
              );
            }
          }
          throw new Error("No event handler found");
        };
      return {
        ...exports,
        default: {
          fetch: handle("fetch"),
          email: handle("email"),
          queue: handle("queue"),
          scheduled: handle("scheduled"),
          tail: handle("tail"),
          trace: handle("trace"),
          tailStream: handle("tailStream"),
          test: handle("test"),
        } satisfies Required<cf.ExportedHandler>,
      };
    }),
  } satisfies WorkerExecutionContext;
});

export declare namespace Worker {
  export type Observability = Workers.ScriptUpdateParams.Metadata.Observability;
  export type Subdomain = Workers.Beta.Workers.Worker.Subdomain;
  export type Binding = NonNullable<
    Workers.Beta.Workers.VersionCreateParams["bindings"]
  >[number];
  export type Limits = Workers.Beta.Workers.Version.Limits;
  export type Placement = Workers.Beta.Workers.Version.Placement;
  export type Assets = Workers.Beta.Workers.Version.Assets;
  export type AssetsConfig = Workers.Beta.Workers.Version.Assets.Config;
  export type Module = Workers.Beta.Workers.Version.Module;

  export interface AssetsProps {
    directory: string;
    config?: AssetsConfig;
  }

  /**
   * Assets configuration that includes a pre-computed hash.
   * When hash is provided, it's used directly for diffing instead of computing from directory contents.
   * This is useful when integrating with Build resources that produce a deterministic hash.
   */
  export interface AssetsWithHash {
    /**
     * Path to the assets directory.
     */
    path: Input<string>;
    /**
     * Pre-computed hash of the assets. When provided, this hash is used for diffing
     * to determine if the worker needs to be redeployed.
     */
    hash: Input<string>;
    /**
     * Optional assets configuration.
     */
    config?: AssetsConfig;
  }
}

const camelCaseKey = (key: string) =>
  key
    .replace(/^_+/, "")
    .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

const toCamelCase = <T>(value: unknown): T => {
  if (Array.isArray(value)) {
    return value.map((item) => toCamelCase(item)) as T;
  }
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        camelCaseKey(key),
        toCamelCase(nested),
      ]),
    ) as T;
  }
  return value as T;
};

type PreparedBundleFile = {
  name: string;
  content: string | ArrayBuffer;
  contentType: string;
};

const stripSourceMapComment = (code: string) =>
  code.replace(/\n?\/\/# sourceMappingURL=.*$/gm, "");

const getModuleContentType = (module: BundledModule) => {
  switch (module.type) {
    case "CompiledWasm":
      return "application/wasm";
    case "Data":
      return "application/octet-stream";
    case "Text":
      if (module.name.endsWith(".html")) return "text/html";
      if (module.name.endsWith(".sql")) return "text/sql";
      return "text/plain";
  }
  return "application/octet-stream";
};

const hashBundleFiles = (files: ReadonlyArray<PreparedBundleFile>) =>
  Effect.gen(function* () {
    const parts = yield* Effect.all(
      files.map((file) =>
        sha256(file.content).pipe(
          Effect.map((hash) => ({
            name: file.name,
            contentType: file.contentType,
            hash,
          })),
        ),
      ),
      {
        concurrency: "unbounded",
      },
    );
    return yield* sha256(JSON.stringify(parts));
  });

export const WorkerProvider = () =>
  Worker.provider.effect(
    Effect.gen(function* () {
      const accountId = yield* Account;
      const getSubdomain = yield* workers.getSubdomain;
      const getScript = yield* workers.getScript;
      const listScripts = yield* workers.listScripts;
      const putScript = yield* workers.putScript;
      const deleteScript = yield* workers.deleteScript;
      const getScriptSubdomain = yield* workers.getScriptSubdomain;
      const createScriptSubdomain = yield* workers.createScriptSubdomain;
      const { read, upload } = yield* Assets.Assets;
      const { build } = yield* Bundle;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotAlchemy = yield* DotAlchemy;

      const getAccountSubdomain = Effect.fnUntraced(function* (
        accountId: string,
      ) {
        const { subdomain } = yield* getSubdomain({
          accountId,
        });
        return subdomain;
      });

      const setWorkerSubdomain = Effect.fnUntraced(function* (
        name: string,
        enabled: boolean,
      ) {
        const subdomain = yield* createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled,
        });
        yield* Effect.logDebug("setWorkerSubdomain", subdomain);
      });

      const createWorkerName = (id: string, name: string | undefined) =>
        Effect.gen(function* () {
          if (name) return name;
          return (yield* createPhysicalName({
            id,
            maxLength: 54,
          })).toLowerCase();
        });

      const findBundleProject = Effect.fnUntraced(function* (entry: string) {
        let current = path.dirname(entry);
        while (true) {
          if (yield* fs.exists(path.join(current, "package.json"))) {
            const relativeEntry = path
              .relative(current, entry)
              .replaceAll("\\", "/");
            const tsconfigCandidates = relativeEntry.startsWith("test/")
              ? ["tsconfig.test.json", "tsconfig.json"]
              : ["tsconfig.json", "tsconfig.test.json"];
            for (const tsconfig of tsconfigCandidates) {
              if (yield* fs.exists(path.join(current, tsconfig))) {
                return {
                  projectRoot: current,
                  tsconfig,
                };
              }
            }
            return {
              projectRoot: current,
              tsconfig: undefined,
            };
          }

          const parent = path.dirname(current);
          if (parent === current) {
            return {
              projectRoot: process.cwd(),
              tsconfig: undefined,
            };
          }
          current = parent;
        }
      });

      const prepareAssets = Effect.fnUntraced(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) return undefined;

        // Handle AssetsWithHash (from Build resource)
        // Props are resolved by Plan, so Input<string> values are already strings at runtime
        if (
          typeof assets === "object" &&
          "path" in assets &&
          "hash" in assets
        ) {
          const path = assets.path as string;
          const hash = assets.hash as string;
          const result = yield* read({
            directory: path,
            config: (assets as Worker.AssetsWithHash).config,
          });
          return {
            ...result,
            hash,
          };
        }

        // Handle string path or AssetsProps
        const result = yield* read(
          typeof assets === "string" ? { directory: assets } : assets,
        );
        return {
          ...result,
          hash: yield* sha256(JSON.stringify(result)),
        };
      });

      const prepareBundle = Effect.fnUntraced(function* (
        id: string,
        props: WorkerProps,
      ) {
        const realMain = yield* fs.realPath(props.main);
        const tempDir = yield* createTempBundleDir(realMain, dotAlchemy, id);
        const realTempDir = yield* fs.realPath(tempDir);
        const tempEntry = path.join(realTempDir, "__index.ts");
        const outputDir = path.join(realTempDir, "out");
        let importPath = path.relative(realTempDir, realMain);
        if (!importPath.startsWith(".")) {
          importPath = `./${importPath}`;
        }
        importPath = importPath.replaceAll("\\", "/");
        const script = `
import * as Effect from "effect/Effect";
import workerExport from "${importPath}";

let workerPromise;
// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const resolveWorker = () => {
  if (workerPromise) return workerPromise;
  // Support both Effect-based workers and plain object exports
  if (Effect.isEffect(workerExport)) {
    workerPromise = Effect.runPromise(workerExport).then(result => result.exports?.default ?? result);
  } else {
    // Plain object export (e.g. { fetch, queue, ... })
    workerPromise = Promise.resolve(workerExport);
  }
  return workerPromise;
}

export default {
  fetch: async (...args) => (await resolveWorker()).fetch?.(...args),
  queue: async (...args) => (await resolveWorker()).queue?.(...args),
  scheduled: async (...args) => (await resolveWorker()).scheduled?.(...args),
  email: async (...args) => (await resolveWorker()).email?.(...args),
  tail: async (...args) => (await resolveWorker()).tail?.(...args),
  trace: async (...args) => (await resolveWorker()).trace?.(...args),
  tailStream: async (...args) => (await resolveWorker()).tailStream?.(...args),
  test: async (...args) => (await resolveWorker()).test?.(...args),
};

// export class proxy stubs for Durable Objects
${props.exports?.map((id) => `export class ${id} {}`).join("\n") ?? ""}
`;
        yield* fs.writeFileString(tempEntry, script);
        return yield* Effect.gen(function* () {
          const { projectRoot, tsconfig } = yield* findBundleProject(realMain);
          const bundle = yield* build({
            main: tempEntry,
            projectRoot,
            outputDir,
            compatibilityDate: props.compatibility?.date,
            compatibilityFlags: props.compatibility?.flags,
            format: "modules",
            minify: true,
            tsconfig,
          });
          const mainModule = "worker.js";
          const code = stripSourceMapComment(
            yield* fs.readFileString(bundle.main),
          );
          const files: Array<PreparedBundleFile> = [
            {
              name: mainModule,
              content: code,
              contentType: "application/javascript+module",
            },
            ...bundle.modules.map((module) => ({
              name: module.name,
              content: module.content.buffer.slice(
                module.content.byteOffset,
                module.content.byteOffset + module.content.byteLength,
              ) as ArrayBuffer,
              contentType: getModuleContentType(module),
            })),
          ];
          return {
            files,
            mainModule,
            hash: yield* hashBundleFiles(files),
          };
        }).pipe(Effect.ensuring(cleanupBundleTempDir(tempDir)));
      });

      const prepareMetadata = Effect.fnUntraced(function* (
        props: WorkerProps,
        mainModule: string,
      ) {
        const metadata: Workers.ScriptUpdateParams.Metadata = {
          assets: undefined,
          bindings: [],
          body_part: undefined,
          compatibility_date: props.compatibility?.date,
          compatibility_flags: props.compatibility?.flags,
          keep_assets: undefined,
          keep_bindings: undefined,
          limits: props.limits,
          logpush: props.logpush,
          main_module: mainModule,
          migrations: undefined,
          observability: props.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocation_logs: true,
            },
          },
          placement: props.placement,
          tags: props.tags,
          tail_consumers: undefined,
          usage_model: undefined,
        };
        return metadata;
      });

      const putWorker = Effect.fnUntraced(function* (
        id: string,
        news: WorkerProps,
        bindings: Worker["Binding"][],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
      ) {
        const name = yield* createWorkerName(id, news.name);
        const [assets, bundle] = yield* Effect.all([
          prepareAssets(news.assets),
          prepareBundle(id, news),
        ]);
        const metadata = yield* prepareMetadata(news, bundle.mainModule);
        metadata.bindings = bindings.flatMap((binding) => binding.bindings);
        if (assets) {
          if (output?.hash?.assets !== assets.hash) {
            const { jwt } = yield* upload(accountId, name, assets, session);
            metadata.assets = {
              jwt,
              config: assets.config,
            };
          } else {
            metadata.assets = {
              config: assets.config,
            };
            metadata.keep_assets = true;
          }
          metadata.bindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        yield* session.note("Uploading worker...");
        const worker = yield* putScript({
          accountId,
          scriptName: name,
          metadata: toCamelCase<workers.PutScriptRequest["metadata"]>(metadata),
          files: bundle.files.map(
            (file) =>
              new File([file.content], file.name, {
                type: file.contentType,
              }),
          ),
        });
        if (!olds || news.subdomain?.enabled !== olds.subdomain?.enabled) {
          const enable = news.subdomain?.enabled !== false;
          yield* session.note(
            `${enable ? "Enabling" : "Disabling"} workers.dev subdomain...`,
          );
          yield* setWorkerSubdomain(name, enable);
        }
        return {
          workerId: worker.id ?? name,
          workerName: name,
          logpush: worker.logpush ?? undefined,
          url:
            news.subdomain?.enabled !== false
              ? `https://${name}.${yield* getAccountSubdomain(accountId)}.workers.dev`
              : undefined,
          tags: metadata.tags,
          accountId,
          hash: {
            assets: assets?.hash,
            bundle: bundle.hash,
          },
        } satisfies Worker["Attributes"];
      });

      return Worker.provider.of({
        stables: ["workerId"],
        diff: Effect.fnUntraced(function* ({ id, news, output }) {
          if (output.accountId !== accountId) {
            return { action: "replace" };
          }
          const workerName = yield* createWorkerName(id, news.name);
          if (workerName !== output.workerName) {
            return { action: "replace" };
          }
          const [assets, bundle] = yield* Effect.all([
            prepareAssets(news.assets),
            prepareBundle(id, news),
          ]);
          if (
            assets?.hash !== output.hash?.assets ||
            bundle.hash !== output.hash?.bundle
          ) {
            return {
              action: "update",
              stables: output.workerName === workerName ? ["name"] : undefined,
            };
          }
        }),
        read: Effect.fnUntraced(function* ({ id, output }) {
          const workerName = yield* createWorkerName(id, output?.workerName);
          return yield* Effect.gen(function* () {
            yield* getScript({
              accountId,
              scriptName: workerName,
            });
            const [worker, subdomain] = yield* Effect.all([
              listScripts({
                accountId,
              }).pipe(
                Effect.map((workers) =>
                  workers.result.find((worker) => worker.id === workerName),
                ),
              ),
              getScriptSubdomain({
                accountId,
                scriptName: workerName,
              }),
            ]);
            if (!worker) {
              return undefined;
            }
            return {
              accountId,
              workerId: worker.id ?? workerName,
              workerName,
              logpush: worker.logpush ?? undefined,
              url: subdomain.enabled
                ? `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`
                : undefined,
              tags: worker.tags ?? undefined,
            } satisfies Worker["Attributes"];
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
        }),
        create: Effect.fnUntraced(function* ({ id, news, bindings, session }) {
          const name = yield* createWorkerName(id, news.name);
          const existing = yield* getScript({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.as(true),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
          );
          if (existing) {
            return yield* Effect.fail(
              new Error(`Worker "${name}" already exists`),
            );
          }
          return yield* putWorker(
            id,
            news,
            bindings,
            undefined,
            undefined,
            session,
          );
        }),
        update: Effect.fnUntraced(function* ({
          id,
          olds,
          news,
          output,
          bindings,
          session,
        }) {
          return yield* putWorker(id, news, bindings, olds, output, session);
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* deleteScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
      });
    }),
  );
