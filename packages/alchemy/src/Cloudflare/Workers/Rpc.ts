import type * as cf from "@cloudflare/workers-types";

import * as Effect from "effect/Effect";
import {
  asEffectOrStream,
  decodeRpcResult,
  makeRpcErrorReviver,
  RpcCallError,
  type RpcErrorClass,
} from "../../Rpc.ts";
import { isYieldableEffect } from "../../Util/effect.ts";
import { fromCloudflareFetcher } from "../Fetcher.ts";

// The transport-agnostic RPC wire protocol (envelopes, error types, stream
// encode/decode, `asEffectOrStream`, and the plain-`fetch` client/server) now
// lives in `src/Rpc.ts` so non-Cloudflare runtimes (e.g. Containers) can reuse
// it. Re-export it here so existing `Cloudflare.*` consumers keep working.
export * from "../../Rpc.ts";

/**
 * Wrap a Cloudflare service-binding stub (or an `Effect` that resolves
 * to one — useful when the stub depends on a service like
 * `WorkerEnvironment` that's only available at *exec* phase) into an
 * Effect-typed RPC client.
 *
 * `Service.fetch`/`Service.connect` are passed through eagerly when the
 * stub is already resolved; everything else is treated as an RPC method
 * whose dispatch is deferred until call time, so the user effect runs in
 * the right runtime layer (which is what `bindWorker` actually wants —
 * its methods are called at exec, even though it's *defined* at init).
 */
export const makeRpcStub = <Shape>(
  stubSource: unknown | Effect.Effect<unknown, never, never>,
  options?: {
    /**
     * Declared error classes (see {@link RpcErrorClass}): failed method
     * results whose `_tag` matches one are reconstructed as real class
     * instances instead of the plain objects RPC serialization produces.
     */
    readonly errors?: ReadonlyArray<RpcErrorClass> | undefined;
  },
): Shape => {
  const isLazy = isYieldableEffect(stubSource);
  const eagerFetcher = isLazy
    ? undefined
    : fromCloudflareFetcher(stubSource as cf.Fetcher);
  const proxyTarget: object = eagerFetcher ?? {};
  const revive = makeRpcErrorReviver(options?.errors);

  return new Proxy(proxyTarget, {
    get: (target: any, prop) => {
      if (!isLazy && prop in target) return target[prop];
      if (typeof prop !== "string" && typeof prop !== "symbol") {
        return target[prop];
      }
      return (...args: any[]) =>
        asEffectOrStream(
          Effect.gen(function* () {
            const stub = isLazy
              ? yield* stubSource as Effect.Effect<any>
              : stubSource;
            return yield* Effect.tryPromise({
              try: () => (stub as any)[prop](...args),
              catch: (cause) =>
                new RpcCallError({ method: String(prop), cause }),
            }).pipe(Effect.flatMap((value) => decodeRpcResult(value, revive)));
          }),
        );
    },
  }) as Shape;
};

export { bindEffectRpc } from "../../Workers/RpcDurableObject.ts";
