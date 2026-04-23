import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import type { ResourceBinding } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { getCompatibility } from "./Compatibility.ts";
import { DevServerClient } from "./DevServer.ts";
import { Worker, type WorkerBinding, type WorkerProps } from "./Worker.ts";
import { createWorkerName } from "./WorkerName.ts";

export const LocalWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const stack = yield* Stack;
      const devServer = yield* DevServerClient;

      const run = Effect.fn(function* (
        id: string,
        props: WorkerProps,
        bindings: ResourceBinding<Worker["Binding"]>[],
      ) {
        const name = yield* createWorkerName(id, props.name);
        const workerBindings: WorkerBinding[] = [];
        const durableObjectNamespaces: Record<string, string> = {};
        for (const { sid, data } of bindings) {
          for (const binding of data.bindings ?? []) {
            workerBindings.push(binding);
            if (binding.type === "durable_object_namespace") {
              durableObjectNamespaces[binding.name] = sid;
            }
          }
        }
        const result = yield* devServer.serve({
          id,
          name,
          main: props.main,
          compatibility: getCompatibility(props),
          entry: props.isExternal
            ? {
                kind: "external",
              }
            : {
                kind: "effect",
                exports: (props.exports ?? {}) as any,
              },
          stack: { name: stack.name, stage: stack.stage },
          accountId,
          bindings: workerBindings,
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

      // TODO(john): Remove after CLI is fixed - this is for debugging when the finalizer is called too soon in a provider
      yield* Effect.addFinalizer(() => {
        console.log("[LocalWorkerProvider] finalizer called");
        return Effect.void;
      });

      return {
        diff: Effect.fn(function* ({ id, olds, news, output }) {
          if (!isResolved(news)) return undefined;
          const oldName =
            output?.workerName ?? (yield* createWorkerName(id, olds.name));
          const newName = yield* createWorkerName(id, news.name);
          return oldName === newName
            ? { action: "update" }
            : { action: "replace" };
        }),
        create: ({ id, news, bindings }) => run(id, news, bindings),
        update: ({ id, news, bindings }) => run(id, news, bindings),
        delete: ({ output }) => devServer.stop(output.workerName),
      };
    }),
  );
