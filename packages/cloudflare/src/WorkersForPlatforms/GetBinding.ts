/// <reference types="@cloudflare/workers-types" />

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
import { maybeDispatchShim } from "./internal/DispatchShim.ts";
import { outboundBindingName, resolveOutbound, toWireOutbound } from "./internal/outbound.ts";

/**
 * Implementation of the {@link Get} binding that uses a native
 * `dispatch_namespace` Worker binding.
 */
export const GetBinding = Layer.effect(
  Get,
  Effect.gen(function* () {
    const env = yield* WorkerEnvironment;
    const host = yield* Worker;
    // Deploy-time ambient context, captured at layer init so the dev shim
    // registration below can run inside the callable, as `QueueBinding` does.
    // Only used under the `__ALCHEMY_RUNTIME__` guard.
    const context = yield* Effect.context<never>();

    return Effect.fn(function* (namespace: DispatchNamespaceResource, options?: GetOptions<any>) {
      const outbound = options?.outbound ? yield* resolveOutbound(options.outbound) : undefined;
      // A binding with an outbound Worker is named after its target, so it
      // stays apart from a plain binding, or another outbound one, on the
      // same namespace.
      const bindingName = outbound ? outboundBindingName(namespace, outbound) : namespace.LogicalId;

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        // A local Worker in a dev run dispatches with an outbound Worker
        // through a deployed shim (see `internal/DispatchShim.ts`).
        const shim = outbound
          ? // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- deploy-time only; remaining requirements are ambient where the Worker is evaluated
            yield* maybeDispatchShim(namespace, outbound, host).pipe(
              Effect.provideContext(context),
            ) as Effect.Effect<Effect.Success<ReturnType<typeof maybeDispatchShim>>>
          : undefined;
        yield* host.bind`${outbound ? bindingName : namespace}`({
          bindings: [
            {
              type: "dispatch_namespace",
              name: bindingName,
              namespace: namespace.name,
              ...(outbound ? { outbound: toWireOutbound(outbound) } : {}),
              ...(shim ? { shim } : {}),
            },
          ],
        });
      }

      const raw = Effect.sync(
        // Lazy — the WorkerEnvironment binding is not populated until runtime.
        () => (env as Record<string, DispatchNamespace>)[bindingName]!,
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
