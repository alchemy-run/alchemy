import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Rpc } from "../../Rpc.ts";
import { isRpcErrorEnvelope, isRpcStreamEnvelope } from "../Bridge.ts";

export type RpcAsync<Shape> = {
  [K in keyof Shape as K extends "fetch" ? never : K]: Shape[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer T, any, any>
    ? (...args: A) => Promise<T>
    : Shape[K] extends (...args: infer A) => Stream.Stream<any, any, any>
      ? (...args: A) => Promise<ReadableStream<Uint8Array>>
      : Shape[K] extends Effect.Effect<infer T, any, any>
        ? Promise<T>
        : Shape[K] extends Stream.Stream<any, any, any>
          ? Promise<ReadableStream<Uint8Array>>
          : Shape[K] extends (...args: infer A) => infer R
            ? (...args: A) => Promise<Awaited<R>>
            : Promise<Shape[K]>;
};

/**
 * Wrap a Cloudflare Worker RPC stub in a `Promise<T>`-shaped proxy so callers
 * outside the Effect runtime (TanStack Start route handlers, plain Workers,
 * test code) can `await` RPC methods directly.
 *
 * The proxy:
 * - leaves `fetch` / `connect` / `Symbol.dispose` and other non-string keys
 *   passing through to the underlying binding unchanged,
 * - turns each `Effect<T>` / `Stream<T>` method into a `Promise<T>` /
 *   `Promise<ReadableStream<Uint8Array>>`,
 * - unwraps the wire envelopes produced by the Effect-side RPC bridge:
 *   `RpcErrorEnvelope` is rethrown via {@link decodeRpcThrowable} so
 *   `try/catch` sees an `Error` (or a tagged error object), and
 *   `RpcStreamEnvelope` is flattened to its `ReadableStream` body.
 *
 * @example
 * ```ts
 * // examples/cloudflare-tanstack/src/routes/api.hello.ts
 * import { toRpcAsync } from "alchemy/Cloudflare/Bridge";
 * import type Backend from "../backend.ts";
 * import { env } from "../env.ts";
 *
 * // `env.BACKEND` is the raw wire-shape Service binding; `backend` is the
 * // Promise<T> view of the Worker's RPC shape.
 * const backend = toRpcAsync<Backend>(env.BACKEND);
 *
 * const value = await backend.hello("some-key");
 * //    ^? string | null   — Effect<string | null> on the worker side
 * ```
 *
 * @example Error handling
 * ```ts
 * // Effect.fail(new MyTaggedError(...)) on the worker side surfaces here as
 * // a thrown value preserving `_tag`, so existing tagged-error checks work.
 * try {
 *   await backend.doThing();
 * } catch (e) {
 *   if ((e as any)._tag === "MyTaggedError") {
 *     // handle it
 *   }
 *   throw e;
 * }
 * ```
 */
export const toRpcAsync = <W>(stub: any): RpcAsync<Rpc.Shape<W>> & Service =>
  new Proxy(stub, {
    get: (target, prop) => {
      // `Service` methods (fetch/connect) and any non-string keys (Symbol.dispose, etc.)
      // pass through to the underlying Cloudflare binding unchanged.
      if (typeof prop !== "string" || prop === "fetch" || prop === "connect") {
        const value = (target as any)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      }

      return async (...args: unknown[]) => {
        const result = await (target as any)[prop](...args);
        if (isRpcErrorEnvelope(result)) {
          throw decodeRpcThrowable(result.error);
        }
        if (isRpcStreamEnvelope(result)) {
          return result.body;
        }
        return result;
      };
    },
  }) as any;

/**
 * Reconstruct a throwable from {@link encodeRpcError}'s wire form. Plain
 * `Error` payloads are rebuilt as `Error` instances so `.message`/`.name`/
 * `.stack` survive. Tagged errors (anything with a `_tag`) and primitives
 * are thrown as-is so `try { ... } catch (e) { if (e._tag === ...) }` keeps
 * working.
 */
const decodeRpcThrowable = (error: unknown): unknown => {
  if (error === null || typeof error !== "object") return error;
  const obj = error as Record<string, unknown>;
  if ("_tag" in obj) return obj;
  if (typeof obj.message === "string" || typeof obj.name === "string") {
    const e = new Error(typeof obj.message === "string" ? obj.message : "");
    if (typeof obj.name === "string") e.name = obj.name;
    if (typeof obj.stack === "string") e.stack = obj.stack;
    return e;
  }
  return error;
};
