/// <reference types="@cloudflare/workers-types" />

import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { Rpc } from "../../Platform.ts";
import type { UnwrapEffect } from "../../Util/effect.ts";
import type * as Cloudflare from "../index.ts";
import type { RpcErrorEnvelope, RpcStreamEnvelope } from "./Rpc.ts";
import type { Worker } from "./Worker.ts";

export type InferEnv<W> = W extends
  | Worker<infer Bindings>
  | Effect.Effect<Worker<infer Bindings>, any, any>
  ? {
      [K in keyof Bindings]: GetBindingType<UnwrapEffect<Bindings[K]>>;
    }
  : never;

/**
 * Cloudflare service-binding wire shape for an Effect-native Worker.
 *
 * Effect/Stream return values are encoded as envelopes on the wire (see
 * `RpcErrorEnvelope`, `RpcStreamEnvelope`), so the mapped types reflect what
 * the raw binding actually resolves to. `fetch` is dropped from the user
 * shape and re-introduced via `Service` so callers get the standard
 * `(input, init?) => Promise<Response>` signature.
 *
 * Use {@link toPromiseApi} to wrap a binding into a Promise<T>-flavored view
 * where envelopes are decoded for you.
 */
export type RpcWireShape<Shape> = {
  [K in keyof Shape as K extends "fetch" ? never : K]: Shape[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer T, any, any>
    ? (...args: A) => Promise<T | RpcErrorEnvelope>
    : Shape[K] extends (...args: infer A) => Stream.Stream<any, any, any>
      ? (...args: A) => Promise<RpcStreamEnvelope | RpcErrorEnvelope>
      : Shape[K] extends Effect.Effect<infer T, any, any>
        ? Promise<T | RpcErrorEnvelope>
        : Shape[K] extends Stream.Stream<any, any, any>
          ? Promise<RpcStreamEnvelope | RpcErrorEnvelope>
          : Shape[K] extends (...args: infer A) => infer R
            ? (...args: A) => Promise<Awaited<R>>
            : Promise<Shape[K]>;
};

/**
 * Recover the user's RPC `Shape` from any of the forms a caller might pass
 * to {@link toPromiseApi}:
 *
 *   - the Worker class value's type, e.g. `typeof Backend`, which extends
 *     `Effect.Effect<Worker & Rpc<Shape>, …>`
 *   - the unwrapped `Worker & Rpc<Shape>` type
 *   - a bare `Shape` (when the caller types it explicitly)
 */
export type ExtractRpcShape<W> =
  W extends Effect.Effect<infer R, any, any>
    ? R extends Rpc<infer Shape>
      ? Shape
      : R
    : W extends Rpc<infer Shape>
      ? Shape
      : W;

/**
 * Promise-flavored consumer view returned by {@link toPromiseApi}: error
 * envelopes are thrown as exceptions and stream envelopes are unwrapped to
 * their raw `ReadableStream<Uint8Array>` body.
 */
export type RpcPromiseShape<Shape> = {
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

export type GetBindingType<T> = T extends Cloudflare.Assets
  ? Service
  : T extends Rpc<infer Shape extends object>
    ? RpcWireShape<Shape> & Service
    : T extends Cloudflare.D1Database
      ? D1Database
      : T extends Cloudflare.R2Bucket
        ? R2Bucket
        : T extends Cloudflare.KVNamespace
          ? KVNamespace
          : T extends Cloudflare.Queue
            ? Queue<unknown>
            : T extends Cloudflare.AiGateway
              ? Ai
              : T extends Cloudflare.AnalyticsEngineDataset
                ? AnalyticsEngineDataset
                : T extends Cloudflare.Artifacts
                  ? Artifacts
                  : T extends Cloudflare.Images
                    ? ImagesBinding
                    : T extends Cloudflare.Hyperdrive
                      ? Hyperdrive
                      : T extends Cloudflare.DurableObjectNamespaceLike
                        ? DurableObjectNamespace<Exclude<T["Shape"], undefined>>
                        : never;
