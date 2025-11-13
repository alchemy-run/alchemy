import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { declare, type To } from "../../policy.ts";
import { getCloudflareEnvKey } from "../context.ts";
import { replaceEffectStream } from "../stream.ts";
import { Bind } from "./namespace.binding.ts";
import type * as KV from "./namespace.ts";

export const get = Effect.fnUntraced(function* <KV extends KV.Namespace>(
  namespace: KV,
  key: string,
) {
  const client = yield* getKvNamespaceFromEnv(namespace);
  return yield* Effect.promise(() => client.get(key));
});

export const getWithMetadata = Effect.fnUntraced(function* <
  KV extends KV.Namespace,
  Metadata = unknown,
>(
  namespace: KV,
  key: string,
  options?: runtime.KVNamespaceGetOptions<undefined>,
) {
  const client = yield* getKvNamespaceFromEnv(namespace);
  return yield* Effect.promise(() =>
    client.getWithMetadata<Metadata>(key, options),
  );
});

export const put = Effect.fnUntraced(function* <KV extends KV.Namespace>(
  namespace: KV,
  key: string,
  value:
    | string
    | ArrayBuffer
    | ArrayBufferView
    | runtime.ReadableStream
    | Stream.Stream<any>,
  options?: runtime.KVNamespacePutOptions,
) {
  const client = yield* getKvNamespaceFromEnv(namespace);
  return yield* Effect.promise(() =>
    client.put(key, replaceEffectStream(value), options),
  );
});

export const del = Effect.fnUntraced(function* <KV extends KV.Namespace>(
  namespace: KV,
  key: string,
) {
  const client = yield* getKvNamespaceFromEnv(namespace);
  return yield* Effect.promise(() => client.delete(key));
});

export const list = Effect.fnUntraced(function* <
  KV extends KV.Namespace,
  Metadata = unknown,
>(namespace: KV, options?: runtime.KVNamespaceListOptions) {
  const client = yield* getKvNamespaceFromEnv(namespace);
  return yield* Effect.promise(() => client.list<Metadata>(options));
});

const getKvNamespaceFromEnv = Effect.fnUntraced(function* <
  KV extends KV.Namespace,
>(namespace: KV) {
  yield* declare<Bind<To<KV>>>();
  return yield* getCloudflareEnvKey<runtime.KVNamespace>(namespace.id);
});
