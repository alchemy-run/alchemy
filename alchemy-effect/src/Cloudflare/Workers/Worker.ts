import type * as cf from "@cloudflare/workers-types";
import {
  Bundler,
  type Module as BundledModule,
} from "@distilled.cloud/cloudflare-bundler";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";
import * as Binding from "../../Binding.ts";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { DotAlchemy } from "../../Config.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  Platform,
  type Main,
  type PlatformServices,
  type Rpc,
} from "../../Platform.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import { sha256 } from "../../Util/index.ts";
import { Account } from "../Account.ts";
import type { AssetsConfig, AssetsProps } from "./Assets.ts";
import * as Assets from "./Assets.ts";
import { workersHttpHandler } from "./HttpServer.ts";
import cloudflare_workers from "./cloudflare:workers.ts";

const WorkerTypeId = "Cloudflare.Worker";
type WorkerTypeId = typeof WorkerTypeId;

export const isWorker = <T>(value: T): value is T & Worker =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  value.Type === WorkerTypeId;

export class WorkerEnvironment extends ServiceMap.Service<
  WorkerEnvironment,
  Record<string, any>
>()("Cloudflare.Workers.WorkerEnvironment") {}

export const WorkerEnvironmentLive = Layer.effect(
  WorkerEnvironment,
  cloudflare_workers.pipe(Effect.map((m) => m.env)),
);

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

type PreparedBundleFile = {
  name: string;
  content: string | ArrayBuffer;
  contentType: string;
};

export interface WorkerObservability extends Exclude<
  workers.PutScriptRequest["metadata"]["observability"],
  undefined
> {}

export interface WorkerLimits extends Exclude<
  workers.PutScriptRequest["metadata"]["limits"],
  undefined
> {}

export type WorkerPlacement = Exclude<
  workers.PutScriptRequest["metadata"]["placement"],
  undefined
>;

export type WorkerBinding = Exclude<
  workers.PutScriptRequest["metadata"]["bindings"],
  undefined
>[number];

export type WorkerProps = {
  /**
   * Worker name override. If omitted, Alchemy derives a deterministic physical
   * name from the stack, stage, and logical ID.
   */
  name?: string;
  /**
   * Whether to enable a workers.dev URL for this worker
   * @default true
   */
  url?: boolean;
  /**
   * Static assets to serve. Can be:
   * - A string path to the assets directory
   * - An AssetsProps object with directory and config
   * - An object with path and hash (e.g., from a Build resource)
   */
  assets?:
    | string
    | AssetsProps
    | AssetsWithHash
    | (AssetsWithHash & { [K: string]: any });
  subdomain?: {
    enabled?: boolean;
    previewsEnabled?: boolean;
  };
  logpush?: boolean;
  observability?: WorkerObservability;
  tags?: string[];
  main: string;
  compatibility?: {
    date?: string;
    flags?: ("nodejs_compat" | "nodejs_als" | (string & {}))[];
  };
  limits?: WorkerLimits;
  placement?: WorkerPlacement;
  env?: Record<string, any>;
  exports?: string[];
};

export interface WorkerExecutionContext extends Serverless.FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
}

export type WorkerServices = Worker | WorkerEnvironment | PlatformServices;

export type WorkerShape = Main<WorkerServices>;

export interface Worker extends Resource<
  WorkerTypeId,
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
    bindings: WorkerBinding[];
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
export const Worker: Platform<
  Worker,
  WorkerServices,
  WorkerShape,
  WorkerExecutionContext
> = Platform(WorkerTypeId, (id: string): WorkerExecutionContext => {
  const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
  const exports: Record<string, any> = {};
  const env: Record<string, any> = {};

  const ctx = {
    Type: WorkerTypeId,
    id,
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
    serve: <Req = never>(handler: HttpEffect<Req>) =>
      ctx.listen(workersHttpHandler(handler)),
    listen: ((
      handler:
        | Serverless.FunctionListener
        | Effect.Effect<Serverless.FunctionListener>,
    ) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as Serverless.FunctionContext["listen"],
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
                Effect.provide(
                  Layer.provideMerge(
                    Layer.mergeAll(Layer.succeed(ExecutionContext, context)),
                    Layer.succeed(
                      WorkerEnvironment,
                      env as Record<string, any>,
                    ),
                  ),
                ),
                Effect.runPromise,
              );
            }
          }
          return Promise.reject(new Error("No event handler found"));
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
  };
  return ctx;
});

export const bindWorker = <Shape extends WorkerShape, Req = never>(
  worker:
    | (Worker & Rpc<Shape>)
    | Effect.Effect<Worker & Rpc<Shape>, never, Req>,
): Effect.Effect<Shape, never, Req> => {};

export class BindWorkerPolicy extends Binding.Policy<
  BindWorkerPolicy,
  (worker: Worker) => Effect.Effect<void>
>()("Cloudflare.Worker.Bind") {}

export const BindWorkerPolicyLive = BindWorkerPolicy.layer.succeed(
  Effect.fn(function* (host, worker: Worker) {
    if (isWorker(host)) {
      yield* host.bind`Bind(${worker})`({
        bindings: [
          {
            type: "service",
            name: worker.LogicalId,
            service: worker.workerName,
          },
        ],
      });
    } else {
      return yield* Effect.die(
        new Error(`BindWorkerPolicy does not support runtime '${host.Type}'`),
      );
    }
  }),
);

export const WorkerProvider = () =>
  Worker.provider.effect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const accountId = yield* Account;
      const bundler = yield* Bundler;
      const dotAlchemy = yield* DotAlchemy;
      const stack = yield* Stack;

      const { read, upload } = yield* Assets.Assets;
      const createScriptSubdomain = yield* workers.createScriptSubdomain;
      const deleteScript = yield* workers.deleteScript;
      const getScript = yield* workers.getScript;
      const getScriptSubdomain = yield* workers.getScriptSubdomain;
      const getSubdomain = yield* workers.getSubdomain;
      const listScripts = yield* workers.listScripts;
      const putScript = yield* workers.putScript;

      const getAccountSubdomain = (accountId: string) =>
        getSubdomain({
          accountId,
        }).pipe(Effect.map((result) => result.subdomain));

      const setWorkerSubdomain = (name: string, enabled: boolean) =>
        createScriptSubdomain({
          accountId,
          scriptName: name,
          enabled,
        });

      const createWorkerName = (id: string, name: string | undefined) =>
        name
          ? Effect.succeed(name)
          : createPhysicalName({
              id,
              maxLength: 54,
            }).pipe(Effect.map((name) => name.toLowerCase()));

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
            config: assets.config,
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
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ServiceMap from "effect/ServiceMap";
import { MinimumLogLevel } from "effect/References";
import * as Console from "effect/Console";
import { WorkerConfigProvider } from "alchemy-effect/Cloudflare";
import { env } from "cloudflare:workers";

import layer from "${importPath}";

const tag = ServiceMap.Service("${Self.key}")

const platform = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer,
  // TODO(sam): wire this up to telemetry more directly
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(
  Stack,
  {
    name: "${stack.name}",
    stage: "${stack.stage}",
    bindings: {},
    resources: {}
  }
);

import util from "node:util";

const handlerEffect = tag.asEffect().pipe(
  Effect.flatMap(func => func.ExecutionContext.exports),
  Effect.map(exports => exports.default),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      // TODO(sam): additional credentials?
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.effect(
          ConfigProvider.ConfigProvider,
          WorkerConfigProvider()
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          MinimumLogLevel,
          env.DEBUG ? "Debug" : "Info",
        )
      ),
    )
  ),
  Effect.scoped
);

// TODO(sam): we could kick this off during module init, but any I/O will break deploy
// let workerPromise = Effect.runPromise(handlerEffect);

// for now, we delay initializing the worker until the first request
let workerPromise;

// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const worker = () => (workerPromise ??= Effect.runPromise(handlerEffect))

export default {
  fetch: async (...args) => (await worker()).fetch(...args),
  queue: async (...args) => (await worker()).queue(...args),
  scheduled: async (...args) => (await worker()).scheduled(...args),
  email: async (...args) => (await worker()).email(...args),
  tail: async (...args) => (await worker()).tail(...args),
  trace: async (...args) => (await worker()).trace(...args),
  tailStream: async (...args) => (await worker()).tailStream(...args),
  test: async (...args) => (await worker()).test(...args),
};

// export class proxy stubs for Durable Objects
${props.exports?.map((id) => `export class ${id} {}`).join("\n") ?? ""}
`;
        yield* fs.writeFileString(tempEntry, script);
        return yield* Effect.gen(function* () {
          const { projectRoot, tsconfig } = yield* findBundleProject(realMain);
          const bundle = yield* bundler.build({
            main: tempEntry,
            rootDir: projectRoot,
            outDir: outputDir,
            minify: true,
            tsconfig,
            cloudflare: {
              compatibilityDate: props.compatibility?.date ?? "2026-03-10",
              compatibilityFlags: props.compatibility?.flags,
            },
          });
          const files: Array<PreparedBundleFile> = bundle.modules.map(
            (module: BundledModule) => ({
              name: module.name,
              content:
                module.name === bundle.main && module.type === "ESModule"
                  ? stripSourceMapComment(
                      Buffer.from(module.content).toString("utf8"),
                    )
                  : (module.content.buffer.slice(
                      module.content.byteOffset,
                      module.content.byteOffset + module.content.byteLength,
                    ) as ArrayBuffer),
              contentType: getModuleContentType(module),
            }),
          );
          return {
            files,
            mainModule: bundle.main,
            hash: yield* hashBundleFiles(files),
          };
        }).pipe(Effect.ensuring(cleanupBundleTempDir(tempDir)));
      });

      const putWorker = Effect.fnUntraced(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
      ) {
        const name = yield* createWorkerName(id, news.name);
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: preparing bundle for ${name}`,
        );
        const [assets, bundle] = yield* Effect.all([
          prepareAssets(news.assets),
          prepareBundle(id, news),
        ]);
        const metadataBindings = bindings.flatMap((b) => b.data.bindings);
        let metadataAssets:
          | workers.PutScriptRequest["metadata"]["assets"]
          | undefined;
        let keepAssets = false;
        if (assets) {
          if (output?.hash?.assets !== assets.hash) {
            yield* Effect.logInfo(
              `Cloudflare Worker ${olds ? "update" : "create"}: uploading assets for ${name}`,
            );
            const { jwt } = yield* upload(accountId, name, assets, session);
            metadataAssets = {
              jwt,
              config: assets.config,
            };
          } else {
            yield* Effect.logInfo(
              `Cloudflare Worker update: reusing existing assets for ${name}`,
            );
            metadataAssets = {
              config: assets.config,
            };
            keepAssets = true;
          }
          metadataBindings.push({
            type: "assets",
            name: "ASSETS",
          });
        }
        metadataBindings.push(
          {
            type: "plain_text",
            name: "ALCHEMY_STACK_NAME",
            text: stack.name,
          },
          {
            type: "plain_text",
            name: "ALCHEMY_STAGE",
            text: stack.stage,
          },
        );
        yield* Effect.logInfo(
          `Cloudflare Worker ${olds ? "update" : "create"}: uploading script for ${name}`,
        );
        yield* session.note("Uploading worker...");
        const metadata = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          compatibilityDate: news.compatibility?.date ?? "2026-03-10",
          compatibilityFlags: news.compatibility?.flags,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.mainModule,
          migrations: undefined,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: news.tags,
          tailConsumers: undefined,
          usageModel: undefined,
        };
        const worker = yield* putScript({
          accountId,
          scriptName: name,
          metadata,
          files: bundle.files.map(
            (file) =>
              new File([file.content], file.name, {
                type: file.contentType,
              }),
          ),
        });
        if (!olds || news.url !== olds.url) {
          const enable = news.url !== false;
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
            news.url !== false
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
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if ((output?.accountId ?? accountId) !== accountId) {
            return { action: "replace" };
          }
          const workerName = yield* createWorkerName(id, news.name);
          const oldWorkerName = output?.workerName
            ? output.workerName
            : yield* createWorkerName(id, olds?.name);
          if (workerName !== oldWorkerName) {
            return { action: "replace" };
          }
          if (!output) {
            return;
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
              stables: oldWorkerName === workerName ? ["name"] : undefined,
            };
          }
        }),
        read: Effect.fnUntraced(function* ({ id, output }) {
          const workerName = yield* createWorkerName(id, output?.workerName);
          yield* Effect.logInfo(
            `Cloudflare Worker read: checking ${workerName}`,
          );
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
              yield* Effect.logInfo(
                `Cloudflare Worker read: ${workerName} not found in script list`,
              );
              return undefined;
            }
            yield* Effect.logInfo(
              `Cloudflare Worker read: found ${workerName}`,
            );
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
          yield* Effect.logInfo(`Cloudflare Worker create: starting ${name}`);
          const existing = yield* getScript({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.as(true),
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
          );
          if (existing) {
            yield* Effect.logInfo(
              `Cloudflare Worker create: ${name} already exists`,
            );
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
          yield* Effect.logInfo(
            `Cloudflare Worker update: starting ${output.workerName}`,
          );
          return yield* putWorker(id, news, bindings, olds, output, session);
        }),
        delete: Effect.fnUntraced(function* ({ output }) {
          yield* Effect.logInfo(
            `Cloudflare Worker delete: deleting ${output.workerName}`,
          );
          yield* deleteScript({
            accountId: output.accountId,
            scriptName: output.workerName,
          }).pipe(Effect.catchTag("WorkerNotFound", () => Effect.void));
        }),
      });
    }),
  );

const stripSourceMapComment = (code: string) =>
  code.replace(/\n?\/\/# sourceMappingURL=.*$/gm, "");

const getModuleContentType = (module: BundledModule) => {
  switch (module.type) {
    case "ESModule":
      return "application/javascript+module";
    case "CompiledWasm":
      return "application/wasm";
    case "Data":
      return "application/octet-stream";
    case "Text":
      if (module.name.endsWith(".html")) return "text/html";
      if (module.name.endsWith(".sql")) return "text/sql";
      return "text/plain";
    case "SourceMap":
      return "application/source-map";
  }
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
