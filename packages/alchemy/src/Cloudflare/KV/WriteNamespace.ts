import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { KVNamespace } from "./Namespace.ts";
import type { KVNamespaceError } from "./NamespaceTypes.ts";

/**
 * Bind a {@link KVNamespace} to a Worker with write access and obtain the
 * Effect-native KV client (`put`, `delete`).
 *
 * `WriteNamespace` is a single identifier that is simultaneously the binding's
 * Context tag, its type, and the callable —
 * `yield* Cloudflare.KV.WriteNamespace(ns)`.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Cloudflare.KVNamespace.Write",
  (namespace: KVNamespace) => Effect.Effect<WriteNamespaceClient>
> {}

export const WriteNamespace = Binding.Service<WriteNamespace>(
  "Cloudflare.KVNamespace.Write",
);

export interface WriteNamespaceClient<Key extends string = string> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
    options?: KVNamespacePutOptions,
  ): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
  delete(key: Key): Effect.Effect<void, KVNamespaceError, RuntimeContext>;
}
