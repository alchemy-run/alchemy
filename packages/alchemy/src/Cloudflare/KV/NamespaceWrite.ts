import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { KVNamespace } from "./Namespace.ts";
import type { KVNamespaceError } from "./NamespaceTypes.ts";

/**
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export class KVNamespaceWrite extends Binding.Service<
  KVNamespaceWrite,
  (namespace: KVNamespace) => Effect.Effect<WriteKVNamespaceClient>
>()("Cloudflare.KVNamespace.Write") {}

export const WriteNamespace = KVNamespaceWrite.bind;

export interface WriteKVNamespaceClient<Key extends string = string> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
  delete(key: Key): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
}
