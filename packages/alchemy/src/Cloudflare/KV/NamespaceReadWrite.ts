import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { KVNamespace } from "./Namespace.ts";
import type { ReadKVNamespaceClient } from "./NamespaceRead.ts";
import type { WriteKVNamespaceClient } from "./NamespaceWrite.ts";

/**
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export class KVNamespaceReadWrite extends Binding.Service<
  KVNamespaceReadWrite,
  (namespace: KVNamespace) => Effect.Effect<ReadWriteKVNamespaceClient>
>()("Cloudflare.KVNamespace.ReadWrite") {}

export const ReadWriteNamespace = KVNamespaceReadWrite.bind;

export interface ReadWriteKVNamespaceClient<Key extends string = string>
  extends ReadKVNamespaceClient<Key>, WriteKVNamespaceClient<Key> {}
