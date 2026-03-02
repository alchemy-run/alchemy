import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import { CloudflareContext } from "../CloudflareContext.ts";
import { replaceEffectStream } from "../stream.ts";
import type { Namespace } from "./Namespace.ts";
import { NamespaceBinding } from "./NamespaceBinding.ts";

export type PutValue =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | runtime.ReadableStream
  | Stream.Stream<any>;

export interface PutOptions extends runtime.KVNamespacePutOptions {}

export class Put extends Binding.Service<
  Put,
  (
    namespace: Namespace,
  ) => Effect.Effect<
    (key: string, value: PutValue, options?: PutOptions) => Effect.Effect<void>
  >
>()("Cloudflare.KV.Put") {}

export const PutLive = Layer.effect(
  Put,
  Effect.gen(function* () {
    const Policy = yield* PutPolicy;
    const { env } = yield* CloudflareContext;

    return Effect.fn(function* (namespace: Namespace) {
      yield* Policy(namespace);
      const kvNamespace = (env as Record<string, runtime.KVNamespace>)[
        namespace.LogicalId
      ];

      return Effect.fn(function* (
        key: string,
        value: PutValue,
        options?: PutOptions,
      ) {
        return yield* Effect.promise(() =>
          kvNamespace.put(key, replaceEffectStream(value), options),
        );
      });
    });
  }),
);

export class PutPolicy extends Binding.Policy<
  PutPolicy,
  (namespace: Namespace) => Effect.Effect<void>
>()("Cloudflare.KV.Put") {}

export const PutPolicyLive = Layer.effect(PutPolicy, NamespaceBinding);
