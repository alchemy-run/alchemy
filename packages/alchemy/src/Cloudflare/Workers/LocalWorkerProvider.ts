import type { HyperdriveOrigin } from "@distilled.cloud/cloudflare-runtime/Worker";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Provider from "../../Provider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { Sidecar } from "../Local/Sidecar.ts";
import { getCompatibility } from "./Compatibility.ts";
import { Worker, type WorkerBinding, type WorkerProps } from "./Worker.ts";
import { createWorkerName } from "./WorkerName.ts";

export const workerBindingsToWranglerConfig = (input: {
  name: string;
  compatibility: { date: string; flags: string[] };
  bindings: WorkerBinding[];
  hyperdrives?: Record<string, Required<HyperdriveOrigin>>;
}) => {
  const config: any = {
    name: input.name,
    compatibility_date: input.compatibility.date,
    compatibility_flags: input.compatibility.flags,
  };

  for (const binding of input.bindings) {
    switch (binding.type) {
      case "plain_text":
      case "secret_text": {
        config.vars ??= {};
        config.vars[binding.name] = binding.text;
        break;
      }
      case "d1": {
        (config.d1_databases ??= []).push({
          binding: binding.name,
          database_id: binding.id,
          database_name: binding.name,
          remote: true,
        });
        break;
      }
      case "kv_namespace": {
        (config.kv_namespaces ??= []).push({
          binding: binding.name,
          id: binding.namespaceId,
          remote: true,
        });
        break;
      }
      case "r2_bucket": {
        (config.r2_buckets ??= []).push({
          binding: binding.name,
          bucket_name: binding.bucketName,
          jurisdiction: binding.jurisdiction,
          remote: true,
        });
        break;
      }
      case "queue": {
        config.queues ??= {};
        (config.queues.producers ??= []).push({
          binding: binding.name,
          queue: binding.queueName,
          remote: true,
        });
        break;
      }
      case "service": {
        (config.services ??= []).push({
          binding: binding.name,
          service: binding.service,
          remote: true,
        });
        break;
      }
      case "ai": {
        config.ai = {
          binding: binding.name,
          remote: true,
        };
        break;
      }
      case "hyperdrive": {
        const origin = input.hyperdrives?.[binding.id];
        (config.hyperdrive ??= []).push({
          binding: binding.name,
          id: binding.id,
          localConnectionString: origin
            ? hyperdriveOriginToConnectionString(origin)
            : undefined,
        });
        break;
      }
      case "durable_object_namespace": {
        config.durable_objects ??= {};
        (config.durable_objects.bindings ??= []).push({
          name: binding.name,
          class_name: binding.className,
          script_name: "scriptName" in binding ? binding.scriptName : undefined,
        });
        break;
      }
    }
  }

  return config;
};

const hyperdriveOriginToConnectionString = (
  origin: Required<HyperdriveOrigin>,
) => {
  const url = new URL(`${origin.scheme}://localhost`);
  url.username = origin.user;
  url.password = origin.password;
  url.hostname = origin.host;
  url.port = String(origin.port);
  url.pathname = `/${origin.database}`;
  if (origin.sslmode) {
    url.searchParams.set("sslmode", origin.sslmode);
  }
  return url.toString();
};

export const LocalWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const stack = yield* Stack;
      const sidecar = yield* Sidecar;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { dotAlchemy } = yield* AlchemyContext;

      const run = Effect.fn(function* (
        id: string,
        props: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
      ) {
        const name = yield* createWorkerName(id, props.name);
        const workerBindings: WorkerBinding[] = [];
        const durableObjectNamespaces: Record<string, string> = {};
        const hyperdrives: Record<string, Required<HyperdriveOrigin>> = {};
        for (const { sid, data } of bindings) {
          for (const binding of data.bindings ?? []) {
            workerBindings.push(binding);
            if (binding.type === "durable_object_namespace") {
              durableObjectNamespaces[binding.name] = sid;
            }
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
          if (Redacted.isRedacted(value)) {
            workerBindings.push({
              type: "secret_text",
              name: key,
              text: Redacted.value(value),
            });
          } else {
            workerBindings.push({
              type: "plain_text",
              name: key,
              text: value,
            });
          }
        }
        const compatibility = getCompatibility(props);
        if (props.vite) {
          const rootDir =
            props.vite.rootDir ?? (yield* Effect.sync(() => process.cwd()));
          const wranglerConfig = workerBindingsToWranglerConfig({
            name,
            compatibility,
            bindings: workerBindings,
            hyperdrives,
          });
          const configHash = JSON.stringify({ rootDir, wranglerConfig });
          const configPath = path.join(
            dotAlchemy,
            "local",
            "vite",
            name,
            "wrangler.json",
          );
          yield* fs.makeDirectory(path.dirname(configPath), {
            recursive: true,
          });
          yield* fs.writeFileString(
            configPath,
            JSON.stringify(wranglerConfig, null, 2),
          );
          const result = yield* sidecar.serveVite({
            id,
            name,
            rootDir,
            wranglerConfigPath: configPath,
            configHash,
          });
          return {
            workerId: name,
            workerName: name,
            logpush: undefined,
            url: result.address,
            tags: [],
            durableObjectNamespaces,
            domains: [],
            accountId,
          } satisfies Worker["Attributes"];
        }
        const result = yield* sidecar.serve({
          id,
          name,
          main: props.main,
          compatibility,
          entry: props.isExternal
            ? {
                kind: "external",
              }
            : {
                kind: "effect",
                exports: (props.exports ?? {}) as any,
              },
          stack: { name: stack.name, stage: stack.stage },
          bindings: workerBindings,
          hyperdrives,
          durableObjectNamespaces: Object.entries(durableObjectNamespaces).map(
            ([className, namespaceId]) => ({
              className,
              uniqueKey: namespaceId,
              sql: true,
            }),
          ),
        });
        return {
          workerId: name,
          workerName: name,
          logpush: undefined,
          url: result.address,
          tags: [],
          durableObjectNamespaces,
          domains: [],
          accountId,
        } satisfies Worker["Attributes"];
      });

      return {
        diff: () => Effect.succeed({ action: "update" }),
        // The local sidecar `serve` operation is itself a true upsert:
        // it tears down any existing process for the worker name and
        // starts a fresh one with the latest bindings, so observe and
        // sync collapse into a single sidecar call.
        reconcile: ({ id, news, bindings }) => run(id, news, bindings),
        delete: ({ output }) => sidecar.stop(output.workerName),
      };
    }),
  );
