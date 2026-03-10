import type * as cf from "@cloudflare/workers-types";
import type { Workers } from "cloudflare/resources";
import * as workers from "distilled-cloudflare/workers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";
import * as Output from "../../Output.ts";

import { Bundler } from "../../Bundle/Bundler.ts";
import type { ScopedPlanStatusSession } from "../../Cli/index.ts";
import { DotAlchemy } from "../../Config.ts";
import {
  Host,
  type ListenHandler,
  type ServerlessExecutionContext,
} from "../../Host.ts";
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
  name?: string;
  assets?: string | Worker.AssetsProps;
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
    exports: Effect.sync(() => ({
      ...exports,
      // construct an Effect that produces the Function's entrypoint
      default: Effect.map(
        Effect.all(listeners, {
          concurrency: "unbounded",
        }),
        (handlers) => {
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
            fetch: handle("fetch"),
            email: handle("email"),
            queue: handle("queue"),
            scheduled: handle("scheduled"),
            tail: handle("tail"),
            trace: handle("trace"),
            tailStream: handle("tailStream"),
            test: handle("test"),
          } satisfies Required<cf.ExportedHandler>;
        },
      ),
    })),
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
      const { build } = yield* Bundler;
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

      const prepareAssets = Effect.fnUntraced(function* (
        assets: WorkerProps["assets"],
      ) {
        if (!assets) return undefined;
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
        const outfile = path.join(dotAlchemy, "out", `${id}.js`);
        const realMain = yield* fs.realPath(props.main);
        const tempRoot = path.join(
          path.dirname(realMain),
          path.basename(dotAlchemy),
          "tmp",
        );

        yield* fs.makeDirectory(tempRoot, { recursive: true });
        const tempDir = yield* fs.makeTempDirectory({
          directory: tempRoot,
          prefix: `${id}-`,
        });

        const realTempDir = yield* fs.realPath(tempDir);
        const tempEntry = path.join(realTempDir, "__index.ts");
        let importPath = path.relative(realTempDir, realMain);
        if (!importPath.startsWith(".")) {
          importPath = `./${importPath}`;
        }
        importPath = importPath.replaceAll("\\", "/");
        const script = `
import * as Effect from "effect/Effect";
import workerEffect from "${importPath}";

let workerPromise;
// don't initialize the workerEffect during module init because Cloudflare does not allow I/O during module init
// we cache it synchronously (??=) to guarnatee only one initialization ever happens
const worker = () => (workerPromise ??= Effect.runPromise(workerEffect))

export default new Proxy({}, {
  get: (_, prop) => async (...args) => 
    (await worker()).exports.default[prop](...args),
});

// export class proxy stubs that
${props.exports?.map((id) => `class ${id} {}`).join("\n") ?? ""}
`;
        yield* fs.writeFileString(tempEntry, script);
        return yield* Effect.gen(function* () {
          yield* build({
            entry: tempEntry,
            outfile,
            format: "esm",
            sourcemap: false,
            treeshake: true,
            minify: true,
          });
          const code = yield* fs.readFileString(outfile);
          return {
            code,
            hash: yield* sha256(code),
          };
        }).pipe(
          Effect.ensuring(
            fs.remove(tempDir, { recursive: true }).pipe(Effect.ignore),
          ),
        );
      });

      const prepareMetadata = Effect.fnUntraced(function* (props: WorkerProps) {
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
          main_module: "worker.js",
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
        const [assets, bundle, metadata] = yield* Effect.all([
          prepareAssets(news.assets),
          prepareBundle(id, news),
          prepareMetadata(news),
        ]);
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
          files: [
            new File([bundle.code], "worker.js", {
              type: "application/javascript+module",
            }),
          ],
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
          logpush: worker.logpush,
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
                  workers.find((worker) => worker.id === workerName),
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
