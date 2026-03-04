import type { Workers } from "cloudflare/resources";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServiceMap from "effect/ServiceMap";

import * as ESBuild from "../../Bundle/ESBuild.ts";
import type { ScopedPlanStatusSession } from "../../Cli/index.ts";
import { DotAlchemy } from "../../Config.ts";
import { Host, type FunctionExecutionContext } from "../../Host.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Resource } from "../../Resource.ts";
import { sha256 } from "../../Util/sha256.ts";
import { Account } from "../Account.ts";
import { CloudflareApi } from "../CloudflareApi.ts";
import * as Assets from "./Assets.ts";

export class WorkerRuntime extends ServiceMap.Service<WorkerRuntime, Worker>()(
  "Cloudflare.Workers.WorkerRuntime",
) {}

export const isWorker = <T>(value: T): value is T & Worker => {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "Cloudflare.Worker"
  );
};

export interface WorkerExecutionContext extends FunctionExecutionContext<"Cloudflare.Worker"> {
  /**
   * An object with properties that are exported from the Worker entrypoint.
   *
   * Equivalent to these in code:
   * ```ts
   * export class MyDo extends DurableObject {
   *   fetch(request: Request) {
   *     return new Response("Hello from MyDo");
   *   }
   * }
   *
   * export default {
   *   fetch: (request: Request) => Promise<Response>;
   *   queue: (message: any) => Promise<void>;
   * }
   * ```
   */
  exports: Record<string, any>;
}

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

export interface Worker
  extends
    WorkerExecutionContext,
    Resource<
      "Cloudflare.Worker",
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

export const Worker = Host<Worker, WorkerRuntime>("Cloudflare.Worker");

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
      ) {
        const outfile = path.join(dotAlchemy, "out", `${id}.js`);
        yield* build({
          entryPoints: [path.relative(process.cwd(), main)],
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
