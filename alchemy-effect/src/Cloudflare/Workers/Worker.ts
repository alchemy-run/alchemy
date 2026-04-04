import type * as cf from "@cloudflare/workers-types";
import {
  Bundler,
  type Module as BundledModule,
} from "@distilled.cloud/cloudflare-bundler";
import * as workers from "@distilled.cloud/cloudflare/workers";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import * as Binding from "../../Binding.ts";
import {
  cleanupBundleTempDir,
  createTempBundleDir,
} from "../../Bundle/TempRoot.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { DotAlchemy } from "../../Config.ts";
import { isResolved } from "../../Diff.ts";
import type { HttpEffect } from "../../Http.ts";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  Platform,
  type Main,
  type PlatformProps,
  type Rpc,
} from "../../Platform.ts";
import type { LogLine } from "../../Provider.ts";
import { Resource, type ResourceBinding } from "../../Resource.ts";
import { Self } from "../../Self.ts";
import * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import { sha256 } from "../../Util/index.ts";
import { Account } from "../Account.ts";
import { CloudflareLogs } from "../Logs.ts";
import type { AssetsConfig, AssetsProps } from "./Assets.ts";
import * as Assets from "./Assets.ts";
import cloudflare_workers from "./cloudflare:workers.ts";
import { isDurableObjectExport } from "./DurableObject.ts";
import { fromCloudflareFetcher } from "./Fetcher.ts";
import { workersHttpHandler } from "./HttpServer.ts";
import { makeRpcStub } from "./Rpc.ts";
import { isWorkflowExport } from "./Workflow.ts";

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
>()("Cloudflare.WorkerEnvironment") {}

export const WorkerEnvironmentLive = Layer.effect(
  WorkerEnvironment,
  cloudflare_workers.pipe(Effect.map((m) => m.env)),
);

export class ExecutionContext extends ServiceMap.Service<
  ExecutionContext,
  cf.ExecutionContext
>()("Cloudflare.ExecutionContext") {}

export type WorkerEvent = Exclude<
  {
    [type in keyof cf.ExportedHandler]: {
      kind: "Cloudflare.WorkerEvent";
      type: type;
      input: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[0];
      env: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[1];
      context: Parameters<Exclude<cf.ExportedHandler[type], undefined>>[2];
    };
  }[keyof cf.ExportedHandler],
  undefined
>;

export const isWorkerEvent = (value: any): value is WorkerEvent =>
  value?.kind === "Cloudflare.WorkerEvent";

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

export const ExportedHandlerMethods = [
  "fetch",
  "tail",
  "trace",
  "tailStream",
  "scheduled",
  "test",
  "email",
  "queue",
] as const satisfies (keyof cf.ExportedHandler)[];

export interface WorkerProps extends PlatformProps {
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
}

export interface WorkerExecutionContext extends Serverless.FunctionContext {
  export(name: string, value: any): Effect.Effect<void>;
}

export type WorkerServices = Worker | WorkerEnvironment;

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
    containers?: { className: string }[];
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
            kind: "Cloudflare.WorkerEvent",
            type,
            input: request,
            env,
            context,
          };
          for (const handler of handlers) {
            const eff = handler(event);
            if (Effect.isEffect(eff)) {
              return eff.pipe(
                Effect.provide(Layer.succeed(ExecutionContext, context)),
                Effect.runPromise,
              );
            }
          }
          return Promise.reject(new Error("No event handler found"));
        };
      return {
        ...exports,
        default: Object.fromEntries(
          ExportedHandlerMethods.map((method) => [method, handle(method)]),
        ),
      };
    }),
  };
  return ctx;
});

export const bindWorker = Effect.fnUntraced(function* <Shape, Req = never>(
  workerEff:
    | (Worker & Rpc<Shape>)
    | Effect.Effect<Worker & Rpc<Shape>, never, Req>,
) {
  const worker = Effect.isEffect(workerEff) ? yield* workerEff : workerEff;
  const self = yield* Worker;
  yield* self.bind`Bind(${worker})`({
    bindings: [
      {
        type: "service",
        name: worker.LogicalId,
        service: worker.workerName,
      },
    ],
  });

  const workerBinding = WorkerEnvironment.asEffect().pipe(
    Effect.map((env) => env[worker.LogicalId]),
  );

  const fetcher = workerBinding.pipe(Effect.map(fromCloudflareFetcher));
  // TODO(sam): update makeRpcStub to support lazily evaluating the Effect<Fetcher>
  return makeRpcStub<Shape>(fetcher);
});

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

function bumpMigrationTagVersion(
  oldTag: string | undefined,
): string | undefined {
  if (!oldTag) return undefined;
  const version = oldTag.match(/^(alchemy:)?v(\d+)$/)?.[2];
  if (!version) return "alchemy:v1";
  return `alchemy:v${parseInt(version, 10) + 1}`;
}

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
      const createScriptTail = yield* workers.createScriptTail;
      const deleteScript = yield* workers.deleteScript;
      const deleteScriptTail = yield* workers.deleteScriptTail;
      const getScript = yield* workers.getScript;
      const getScriptSubdomain = yield* workers.getScriptSubdomain;
      const telemetry = yield* CloudflareLogs;
      const getScriptSettings = yield* workers.getScriptScriptAndVersionSetting;
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

      const createAlchemyWorkerTags = (id: string) => [
        `alchemy:stack:${stack.name}`,
        `alchemy:stage:${stack.stage}`,
        `alchemy:id:${id}`,
      ];

      const hasAlchemyWorkerTags = (
        id: string,
        tags: readonly string[] | undefined,
      ) => {
        const actualTags = new Set(tags ?? []);
        return createAlchemyWorkerTags(id).every((tag) => actualTags.has(tag));
      };

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
        const buildBundle = (entry: string) =>
          Effect.gen(function* () {
            const { projectRoot, tsconfig } =
              yield* findBundleProject(realMain);
            const bundle = yield* bundler.build({
              main: entry,
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
                contentType:
                  getModuleContentType(module) ?? "application/octet-stream",
              }),
            );
            return {
              files,
              mainModule: bundle.main,
              hash: yield* hashBundleFiles(files),
            };
          });

        if (props.isExternal) {
          return yield* buildBundle(realMain).pipe(
            Effect.ensuring(cleanupBundleTempDir(tempDir)),
          );
        }

        let importPath = path.relative(realTempDir, realMain);
        if (!importPath.startsWith(".")) {
          importPath = `./${importPath}`;
        }
        importPath = importPath.replaceAll("\\", "/");
        const exportMap = (props.exports ?? {}) as Record<string, unknown>;
        const allExportNames = Object.keys(exportMap).filter(
          (id) => id !== "default",
        );
        const doClasses: string[] = [];
        const wfClasses: string[] = [];
        for (const name of allExportNames) {
          if (isWorkflowExport(exportMap[name])) {
            wfClasses.push(name);
          } else if (isDurableObjectExport(exportMap[name])) {
            doClasses.push(name);
          }
        }
        const hasDoClasses = doClasses.length > 0;
        const hasWfClasses = wfClasses.length > 0;
        const script = `
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";

import { env, DurableObject${hasWfClasses ? ", WorkflowEntrypoint" : ""} } from "cloudflare:workers";
import { MinimumLogLevel } from "effect/References";
import { NodeServices } from "@effect/platform-node";
import { Stack } from "alchemy-effect/Stack";
import { WorkerEnvironment, makeDurableObjectBridge${hasWfClasses ? ", makeWorkflowBridge" : ""}, ExportedHandlerMethods } from "alchemy-effect/Cloudflare";

import entry from "${importPath}";

const tag = ServiceMap.Service("${Self.key}")
const layer =
  typeof entry?.build === "function"
    ? entry
    : Layer.effect(tag, typeof entry?.asEffect === "function" ? entry.asEffect() : entry);

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

const exportsEffect = tag.asEffect().pipe(
  Effect.flatMap(func => func.ExecutionContext.exports),
  Effect.map(exports => exports),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      // TODO(sam): additional credentials?
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(env),
        )
      ),
      Layer.provideMerge(
        Layer.succeed(
          WorkerEnvironment,
          env,
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
// let exportsPromise = Effect.runPromise(exportsEffect);

// for now, we delay initializing the worker until the first request
let exportsPromise;

// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const getExports = () => (exportsPromise ??= Effect.runPromise(exportsEffect))
const getExport = (name) => getExports().then(exports => exports[name]?.make)
const worker = () => getExports().then(exports => exports.default)

export default Object.fromEntries(ExportedHandlerMethods.map(
  method => [method, async (...args) => (await worker())[method](...args)])
) satisfies Required<cf.ExportedHandler>;

// export class proxy stubs for Durable Objects and Workflows
${[
  ...(hasDoClasses
    ? [
        "const DurableObjectBridge = makeDurableObjectBridge(DurableObject, getExport);",
        ...doClasses.map(
          (id) => `export class ${id} extends DurableObjectBridge("${id}") {}`,
        ),
      ]
    : []),
  ...(hasWfClasses
    ? [
        "const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, getExport);",
        ...wfClasses.map(
          (id) => `export class ${id} extends WorkflowBridgeFn("${id}") {}`,
        ),
      ]
    : []),
].join("\n")}
`;
        yield* fs.writeFileString(tempEntry, script);

        return yield* buildBundle(tempEntry).pipe(
          Effect.ensuring(cleanupBundleTempDir(tempDir)),
        );
      });

      const putWorker = Effect.fnUntraced(function* (
        id: string,
        news: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
        olds: WorkerProps | undefined,
        output: Worker["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
        existingSettings?: workers.GetScriptScriptAndVersionSettingResponse,
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

        // Collect new DO bindings from the metadata bindings list (keyed by binding name)
        const newDoBindings = new Map<
          string,
          { className: string; scriptName?: string }
        >();
        for (const b of metadataBindings) {
          if (
            b.type === "durable_object_namespace" &&
            "className" in b &&
            b.className
          ) {
            newDoBindings.set(b.name, {
              className: b.className,
              scriptName: "scriptName" in b ? b.scriptName : undefined,
            });
          }
        }

        // Read existing worker settings for migration tracking
        const oldSettings =
          existingSettings ??
          (yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.map((s) => s as typeof s | undefined),
            Effect.catch(() => Effect.succeed(undefined)),
          ));

        const oldTags = Array.from(new Set(oldSettings?.tags ?? []));
        const oldBindings = oldSettings?.bindings ?? [];

        // Parse alchemy:do:{stableId}:{bindingName} tags
        const bindingNameToStableId = Object.fromEntries(
          oldTags.flatMap((tag) => {
            if (tag.startsWith("alchemy:do:")) {
              const parts = tag.split(":");
              return [[parts[3], parts[2]]];
            }
            return [];
          }),
        );

        // Parse alchemy:migration-tag:{version}
        const oldMigrationTag = oldTags.flatMap((tag) =>
          tag.startsWith("alchemy:migration-tag:")
            ? [tag.slice("alchemy:migration-tag:".length)]
            : [],
        )[0];
        const newMigrationTag = bumpMigrationTagVersion(oldMigrationTag);

        // Compute deleted classes
        const deletedClasses: string[] = [];
        for (const oldBinding of oldBindings) {
          if (
            oldBinding.type === "durable_object_namespace" &&
            "className" in oldBinding &&
            oldBinding.className &&
            (!("scriptName" in oldBinding) ||
              !oldBinding.scriptName ||
              oldBinding.scriptName === name)
          ) {
            const stableId = bindingNameToStableId[oldBinding.name];
            if (stableId) {
              const stillExists = [...bindings].some(
                (rb) => rb.sid === stableId,
              );
              if (!stillExists) {
                deletedClasses.push(oldBinding.className);
              }
            } else {
              if (!newDoBindings.has(oldBinding.name)) {
                deletedClasses.push(oldBinding.className);
              }
            }
          }
        }

        // Collect container-backed class names so we can send container metadata
        const containerClassNames = new Set(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map((c) => c.className),
          ),
        );

        // Compute new and renamed classes
        const newClasses: string[] = [];
        const newSqliteClasses: string[] = [];
        const renamedClasses: { from: string; to: string }[] = [];
        for (const rb of bindings) {
          for (const b of rb.data.bindings) {
            if (
              b.type === "durable_object_namespace" &&
              "className" in b &&
              b.className &&
              (!("scriptName" in b) || !b.scriptName || b.scriptName === name)
            ) {
              const prevOldBinding = oldBindings.find(
                (ob) =>
                  ob.type === "durable_object_namespace" &&
                  (bindingNameToStableId[ob.name] === rb.sid ||
                    (!bindingNameToStableId[ob.name] && ob.name === b.name)),
              );
              if (!prevOldBinding) {
                // Default all new Durable Object classes to SQLite. Cloudflare
                // recommends SQLite for new namespaces, and container-backed
                // Durable Objects require it.
                newSqliteClasses.push(b.className);
              } else if (
                "className" in prevOldBinding &&
                prevOldBinding.className !== b.className
              ) {
                renamedClasses.push({
                  from: prevOldBinding.className!,
                  to: b.className,
                });
              }
            }
          }
        }

        // Build alchemy:do:{sid}:{bindingName} tags for each DO binding
        const alchemyDoTags: string[] = [];
        for (const rb of bindings) {
          for (const b of rb.data.bindings) {
            if (b.type === "durable_object_namespace" && "className" in b) {
              alchemyDoTags.push(`alchemy:do:${rb.sid}:${b.name}`);
            }
          }
        }

        const metadataTags = Array.from(
          new Set([
            ...createAlchemyWorkerTags(id),
            ...alchemyDoTags,
            ...(newMigrationTag
              ? [`alchemy:migration-tag:${newMigrationTag}`]
              : []),
            ...(news.tags ?? []),
          ]),
        );

        const migrations = {
          oldTag: oldMigrationTag,
          newTag: newMigrationTag,
          newClasses,
          deletedClasses,
          renamedClasses,
          transferredClasses: [] as { from: string; to: string }[],
          newSqliteClasses,
        };

        const metadataContainers = [...containerClassNames].map(
          (className) => ({
            className,
          }),
        );

        const metadata = {
          assets: metadataAssets,
          bindings: metadataBindings,
          bodyPart: undefined,
          compatibilityDate: news.compatibility?.date ?? "2026-03-10",
          compatibilityFlags: news.compatibility?.flags,
          containers:
            metadataContainers.length > 0 ? metadataContainers : undefined,
          keepAssets,
          keepBindings: undefined,
          limits: news.limits,
          logpush: news.logpush,
          mainModule: bundle.mainModule,
          migrations,
          observability: news.observability ?? {
            enabled: true,
            logs: {
              enabled: true,
              invocationLogs: true,
            },
          },
          placement: news.placement,
          tags: metadataTags,
          tailConsumers: undefined,
          usageModel: undefined,
        };
        const scriptFiles = bundle.files.map(
          (file) =>
            new File([file.content], file.name, {
              type: file.contentType,
            }),
        );
        const worker = yield* putScript({
          accountId,
          scriptName: name,
          metadata,
          files: scriptFiles,
        }).pipe(
          Effect.catch((err) => {
            // When adopting a Worker managed by Wrangler (or after a previous
            // deploy with mismatched migrations), the old_tag precondition
            // fails. The only way to discover the actual tag is through the
            // error message — getScriptSettings is meant to return it but
            // doesn't at runtime.
            const msg = String(
              typeof err === "object" && err !== null && "message" in err
                ? err.message
                : err,
            );
            const expectedTag = msg.match(
              /when expected tag is ['"]?([^'"]+)['"]?/,
            )?.[1];
            if (expectedTag) {
              return putScript({
                accountId,
                scriptName: name,
                metadata: {
                  ...metadata,
                  migrations: {
                    ...migrations,
                    oldTag: expectedTag,
                    newTag: bumpMigrationTagVersion(expectedTag),
                  },
                },
                files: scriptFiles,
              });
            }
            return Effect.fail(err as any);
          }),
        );
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
        stables: ["workerId", "workerName"],
        diff: Effect.fnUntraced(function* ({ id, news, olds, output }) {
          if (!isResolved(news)) return undefined;
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
              stables:
                oldWorkerName === workerName ? ["workerName"] : undefined,
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
            const [worker, subdomain, settings] = yield* Effect.all([
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
              getScriptSettings({
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
              tags: settings.tags ?? undefined,
            } satisfies Worker["Attributes"];
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
        }),
        create: Effect.fnUntraced(function* ({ id, news, bindings, session }) {
          const name = yield* createWorkerName(id, news.name);
          yield* Effect.logInfo(`Cloudflare Worker create: starting ${name}`);
          const existingSettings = yield* getScriptSettings({
            accountId,
            scriptName: name,
          }).pipe(
            Effect.catchTag("WorkerNotFound", () => Effect.succeed(undefined)),
          );
          if (existingSettings) {
            yield* Effect.logInfo(
              `Cloudflare Worker create: ${name} already exists`,
            );
            if (!hasAlchemyWorkerTags(id, existingSettings.tags ?? [])) {
              return yield* Effect.die(
                `Worker "${name}" already exists but is not owned by this stack/stage/resource`,
              );
            }
            yield* Effect.logInfo(
              `Cloudflare Worker create: adopting existing ${name} owned by this stack/stage/resource`,
            );
          }
          return yield* putWorker(
            id,
            news,
            bindings,
            undefined,
            undefined,
            session,
            existingSettings,
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
        tail: ({ output }) => {
          const runTailSession = Effect.gen(function* () {
            const { id: tailId, url } = yield* createScriptTail({
              scriptName: output.workerName,
              accountId: output.accountId,
              body: { filters: [] },
            });

            const socket = yield* Socket.makeWebSocket(url, {
              protocols: ["trace-v1"],
            });

            const queue = yield* Queue.make<LogLine, Cause.Done>();

            yield* socket
              .runRaw((raw) => {
                const text =
                  typeof raw === "string" ? raw : new TextDecoder().decode(raw);
                const data: TailEventMessage = JSON.parse(text);
                const eventTs = new Date(data.eventTimestamp ?? Date.now());

                if (data.event && "request" in data.event) {
                  const reqEvent = data.event;
                  const pathname = (() => {
                    try {
                      return new URL(reqEvent.request.url).pathname;
                    } catch {
                      return reqEvent.request.url;
                    }
                  })();
                  const status = reqEvent.response?.status ?? 500;
                  Queue.offerUnsafe(queue, {
                    timestamp: eventTs,
                    message: `${reqEvent.request.method} ${pathname} > ${status} (cpu: ${Math.round(data.cpuTime)}ms, wall: ${Math.round(data.wallTime)}ms)`,
                  });
                }

                for (const log of data.logs) {
                  const msg = log.message.join(" ");
                  Queue.offerUnsafe(queue, {
                    timestamp: new Date(log.timestamp),
                    message: log.level === "log" ? msg : `${log.level}: ${msg}`,
                  });
                }

                for (const exception of data.exceptions) {
                  Queue.offerUnsafe(queue, {
                    timestamp: new Date(exception.timestamp),
                    message: `${exception.name} ${exception.message}\n${exception.stack}`,
                  });
                }
              })
              .pipe(
                Effect.ensuring(
                  Effect.all([
                    deleteScriptTail({
                      scriptName: output.workerName,
                      id: tailId,
                      accountId: output.accountId,
                    }).pipe(Effect.ignore),
                    Queue.end(queue),
                  ]),
                ),
                Effect.ignore,
                Effect.forkChild(),
              );

            return Stream.fromQueue(queue);
          });

          return Stream.unwrap(runTailSession).pipe(
            Stream.repeat(Schedule.spaced("1 second")),
          );
        },
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: [
              {
                key: "$workers.scriptName",
                operation: "eq",
                type: "string",
                value: output.workerName,
              },
            ],
            options,
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

interface TailEventMessage {
  eventTimestamp?: number;
  wallTime: number;
  cpuTime: number;
  truncated: boolean;
  outcome: string;
  scriptName: string;
  exceptions: {
    name: string;
    message: string;
    stack: string;
    timestamp: string;
  }[];
  logs: {
    message: string[];
    level: string;
    timestamp: string;
  }[];
  event:
    | {
        request: { method: string; url: string };
        response?: { status: number };
      }
    | null
    | undefined;
}
