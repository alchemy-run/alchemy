import type * as cf from "@cloudflare/workers-types";

import type { Workers } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";

import * as ESBuild from "../../Bundle/ESBuild.ts";
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
import { CloudflareApi } from "../CloudflareApi.ts";
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
>(
  "Cloudflare.Workers.Worker",
  Effect.gen(function* () {
    const listeners: Effect.Effect<ListenHandler>[] = [];
    const exports: Record<string, any> = {};

    return {
      type: "Cloudflare.Workers.Worker",
      run: undefined!,
      get: () => Effect.succeed(undefined!),
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
  }),
);

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

export const WorkerProvider = () =>
  Worker.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;
      const { read, upload } = yield* Assets.Assets;
      const { build } = yield* ESBuild.ESBuild;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotAlchemy = yield* DotAlchemy;

      const getAccountSubdomain = Effect.fnUntraced(function* (
        accountId: string,
      ) {
        const { subdomain } = yield* api.workers.subdomains.get({
          account_id: accountId,
        });
        return subdomain;
      });

      const setWorkerSubdomain = Effect.fnUntraced(function* (
        name: string,
        enabled: boolean,
      ) {
        const subdomain = yield* api.workers.scripts.subdomain.create(name, {
          account_id: accountId,
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
        main: string,
        handler = "default",
      ) {
        const outfile = path.join(dotAlchemy, "out", `${id}.js`);
        const entrypoint = path.relative(process.cwd(), main);
        yield* build({
          stdin: {
            contents: `import { ${handler} as handler } from "${entrypoint}";
import * as Effect from "effect/Effect";
export default await Effect.runPromise(handler);`,
            resolveDir: process.cwd(),
            loader: "ts",
            sourcefile: "__index.ts",
          },
          // entryPoints: [path.relative(process.cwd(), main)],
          outfile,
          write: true,
          bundle: true,
          format: "esm",
          sourcemap: false,
          treeShaking: true,
        });
        const code = yield* fs.readFileString(outfile);
        return {
          code,
          hash: yield* sha256(code),
        };
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
          prepareBundle(id, news.main),
          prepareMetadata(news),
        ]).pipe(Effect.orDie);
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
        const worker = yield* api.workers.scripts.update(name, {
          account_id: accountId,
          metadata: metadata,
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
          workerId: worker.id!,
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
            prepareBundle(id, news.main),
          ]).pipe(Effect.orDie);
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
          const worker = yield* api.workers.beta.workers.get(workerName, {
            account_id: accountId,
          });
          return {
            accountId,
            workerId: worker.id,
            workerName: worker.name,
            logpush: worker.logpush,
            observability: worker.observability,
            subdomain: {
              enabled: worker.subdomain.enabled,
              previews_enabled: worker.subdomain.previews_enabled,
            },
            url: worker.subdomain.enabled
              ? `https://${workerName}.${yield* getAccountSubdomain(accountId)}.workers.dev`
              : undefined,
            tags: worker.tags,
          };
        }),
        create: Effect.fnUntraced(function* ({ id, news, bindings, session }) {
          const name = yield* createWorkerName(id, news.name);
          const existing = yield* api.workers.beta.workers
            .get(name, {
              account_id: accountId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
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
          yield* api.workers.scripts
            .delete(output.workerId, {
              account_id: output.accountId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      });
    }),
  );
