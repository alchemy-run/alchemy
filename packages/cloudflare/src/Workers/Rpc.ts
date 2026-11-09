import type * as cf from "@cloudflare/workers-types";
import {
  asEffectOrStream,
  currentRpcMeta,
  decodeRpcResult,
  makeRpcErrorReviver,
  RPC_PROTOCOL_VERSION,
  RPC_REQUEST_METHOD,
  RpcCallError,
  type RpcErrorClass,
  type RpcRequest,
} from "alchemy/Rpc";
import { isYieldableEffect } from "alchemy/Util/effect";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fromCloudflareFetcher } from "../Fetcher.ts";
import { isPlaceholderReset } from "./Placeholder.ts";

// The transport-agnostic RPC wire protocol (envelopes, error types, stream
// encode/decode, `asEffectOrStream`, and the plain-`fetch` client/server) now
// lives in `src/Rpc.ts` so non-Cloudflare runtimes (e.g. Containers) can reuse
// it. Re-export it here so existing `Cloudflare.*` consumers keep working.
export * from "alchemy/Rpc";

/**
 * Whether a call failed because the host doesn't serve `~alchemy/rpc` yet: an
 * isolate still running a deploy that predates it, which treats the name as
 * an unknown user method. The message is the one every earlier bridge
 * (Durable Object and Worker entrypoint) produces.
 */
const isRequestMethodMissing = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  "message" in cause &&
  typeof cause.message === "string" &&
  cause.message.includes(`Method "${RPC_REQUEST_METHOD}" not found`);

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
  stubSource: unknown,
  options?: {
    /**
     * Declared error classes (see {@link RpcErrorClass}): failed method
     * results whose `_tag` matches one are reconstructed as real class
     * instances instead of the plain objects RPC serialization produces.
     */
    readonly errors?: ReadonlyArray<RpcErrorClass> | undefined;
    /**
     * How calls reach the callee:
     *
     * - `"envelope"`: one `~alchemy/rpc` call carrying the method, its
     *   arguments untouched, and the call's metadata (the caller's trace
     *   context). Only for a callee known to run Alchemy's bridge of this
     *   version or later — a Durable Object or Worker built by the same
     *   deploy. While a deploy rolls out, a host still on older code rejects
     *   the method as unknown; the call is retried until it isn't.
     * - `"direct"`: the method itself, with exactly the caller's arguments
     *   and no metadata — for any other callee (plain JS, another stack, a
     *   script name).
     *
     * @default "direct"
     */
    readonly protocol?: "envelope" | "direct" | undefined;
  },
): Shape => {
  const isLazy = isYieldableEffect(stubSource);
  const eagerFetcher = isLazy ? undefined : fromCloudflareFetcher(stubSource as cf.Fetcher);
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
            // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- untyped lazy stub source
            const stub = isLazy ? yield* stubSource as Effect.Effect<any> : stubSource;
            const envelope =
              options?.protocol === "envelope"
                ? ({
                    v: RPC_PROTOCOL_VERSION,
                    method: String(prop),
                    args,
                    meta: yield* currentRpcMeta,
                  } satisfies RpcRequest)
                : undefined;
            return yield* Effect.tryPromise({
              try: () =>
                envelope === undefined
                  ? (stub as any)[prop](...args)
                  : (stub as any)[RPC_REQUEST_METHOD](envelope),
              catch: (cause) => new RpcCallError({ method: String(prop), cause }),
            }).pipe(
              // Right after a deploy, an object can still start on the
              // placeholder script, which runs none of the real code and
              // resets itself so the next call gets the deployed code. The
              // new code can take a while to reach every edge (~35s here).
              Effect.retry({
                while: (error) =>
                  isPlaceholderReset(error.cause) ||
                  (envelope !== undefined && isRequestMethodMissing(error.cause)),
                schedule: Schedule.min([
                  Schedule.exponential("200 millis"),
                  Schedule.spaced("2 seconds"),
                ]),
                times: 20,
              }),
              Effect.flatMap((value) => decodeRpcResult(value, revive)),
            );
          }),
        );
    },
  }) as Shape;
};

export { bindEffectRpc } from "alchemy/Workers/EffectRpc";
