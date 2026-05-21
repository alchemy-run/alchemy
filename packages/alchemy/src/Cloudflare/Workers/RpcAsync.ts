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
