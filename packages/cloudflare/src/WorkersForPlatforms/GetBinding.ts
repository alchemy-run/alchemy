/// <reference types="@cloudflare/workers-types" />

import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import type { DispatchNamespace as DispatchNamespaceResource } from "./DispatchNamespace.ts";
import {
  type DispatchNamespaceClient,
  DispatchNamespaceError,
  Get,
  type GetOptions,
} from "./Get.ts";
import { dispatchNamespaceBinding, resolveOutboundWorker } from "./internal/outbound.ts";

/**
 * Implementation of the {@link Get} binding that uses a native
 * `dispatch_namespace` Worker binding.
 */
export const GetBinding = Layer.effect(
  Get,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;

    return Effect.fn(function* (namespace: DispatchNamespaceResource, options?: GetOptions<any>) {
      const outbound = yield* resolveOutboundWorker(options);
      // A binding with an outbound Worker is named after it, apart from a
      // plain binding on the same namespace. A `Worker.ref(...)` has no
      // `LogicalId`, so its id comes from the ref.
      const name = outbound
        ? `${namespace.LogicalId}_${Output.isRefExpr(outbound) ? outbound.resourceId : outbound.LogicalId}`
        : namespace.LogicalId;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* host.bind`${outbound ? name : namespace}`({
          bindings: [dispatchNamespaceBinding(name, namespace, outbound, options)],
        });
      }

      const raw = Effect.sync(
        // Lazy — the WorkerEnvironment binding is not populated until runtime.
        () => (env as Record<string, DispatchNamespace>)[name]!,
      );

      const self: DispatchNamespaceClient<any> = {
        raw,
        get: (name, args, options) =>
          raw.pipe(
            Effect.flatMap((ns) =>
              Effect.try({
                try: () => ns.get(name, args, options),
                catch: (error) =>
                  new DispatchNamespaceError({
                    message:
                      error instanceof Error
                        ? error.message
                        : "Unknown dispatch namespace runtime error",
                    cause: error,
                  }),
              }),
            ),
          ),
      };
      return self;
    });
  }),
);
