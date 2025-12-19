import * as FileSystem from "@effect/platform/FileSystem";
import * as Path from "@effect/platform/Path";
import type { Workers } from "cloudflare/resources.mjs";
import * as Effect from "effect/Effect";
import type { ScopedPlanStatusSession } from "../../cli/service.ts";
import { DotAlchemy } from "../../dot-alchemy.ts";
import { ESBuild } from "../../esbuild.ts";
import { createPhysicalName } from "../../physical-name.ts";
import { sha256 } from "../../sha256.ts";
import { Account } from "../account.ts";
import { CloudflareApi } from "../api.ts";
import { Assets } from "./assets.provider.ts";
import { Worker, type WorkerAttr, type WorkerProps } from "./worker.ts";

export const workerProvider = () =>
  Worker.provider.effect(
    Effect.gen(function* () {
      const api = yield* CloudflareApi;
      const accountId = yield* Account;
      const { read, upload } = yield* Assets;
      const { build } = yield* ESBuild;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dotAlchemy = yield* DotAlchemy;

      const getAccountSubdomain = yield* Effect.cachedFunction(
        Effect.fnUntraced(function* (accountId: string) {
          const { subdomain } = yield* api.workers.subdomains.get({
            account_id: accountId,
          });
          return subdomain;
        }),
      );

      // pre-fetch subdomain in background
      yield* Effect.forkDaemon(getAccountSubdomain(accountId));

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

      const prepareMetadata = Effect.fnUntraced(function* (
        props: WorkerProps<any>,
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
        news: WorkerProps<any>,
        bindings: Worker["binding"][],
        olds: WorkerProps<any> | undefined,
        output: WorkerAttr<WorkerProps<any>> | undefined,
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
          if (output?.hash.assets !== assets.hash) {
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
          workerId: worker.id,
          workerName: name,
          logpush: worker.logpush,
          observability: metadata.observability,
          subdomain: news.subdomain ?? {
            enabled: true,
            previews_enabled: true,
          },
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
        } as WorkerAttr<WorkerProps<any>>;
      });

      return {
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
            assets?.hash !== output.hash.assets ||
            bundle.hash !== output.hash.bundle
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
          } as WorkerAttr<WorkerProps<any>>;
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
      };
    }),
  );
