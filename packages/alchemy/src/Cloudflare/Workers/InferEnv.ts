/// <reference types="@cloudflare/workers-types" />

import type * as Effect from "effect/Effect";
import type { Rpc } from "../../Platform.ts";
import type { UnwrapEffect } from "../../Util/effect.ts";
import type * as Cloudflare from "../index.ts";
import type { Worker } from "./Worker.ts";

export type InferEnv<W> = W extends
  | Worker<infer Bindings>
  | Effect.Effect<Worker<infer Bindings>, any, any>
  ? {
      [K in keyof Bindings]: GetBindingType<UnwrapEffect<Bindings[K]>>;
    }
  : never;

export type GetBindingType<T> = T extends Cloudflare.Assets
  ? Service
  : T extends Rpc<infer Shape extends object>
    ? {
        [k in keyof Shape]: Shape[k] extends Effect.Effect<
          infer T,
          infer _E,
          infer _R
        >
          ? Promise<T>
          : Shape[k] extends (
                ...args: infer Args
              ) => Effect.Effect<infer T, infer _E, infer _R>
            ? (...args: Args) => Promise<T>
            : Shape[k];
      } & Service
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
              : T extends Cloudflare.Artifacts
                ? Artifacts
                : T extends Cloudflare.Images
                  ? ImagesBinding
                  : T extends Cloudflare.Hyperdrive
                    ? Hyperdrive
                    : T extends Cloudflare.DurableObjectNamespaceLike
                      ? DurableObjectNamespace<Exclude<T["Shape"], undefined>>
                      : never;
