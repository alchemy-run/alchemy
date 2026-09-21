import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Namespace } from "./Namespace.ts";
import type { NamespaceError, NamespacePutOptions } from "./NamespaceTypes.ts";

export interface WriteNamespace extends Binding.Service<
  WriteNamespace,
  "Celld.KV.WriteNamespace",
  (namespace: Namespace) => Effect.Effect<WriteNamespaceClient>
> {}

/**
 * Write to a Celld namespace's single writer. Celld 0.5 accepts strings,
 * ArrayBuffers and typed arrays, but not streams or blobs. Metadata is JSON;
 * larger values may be backed by the fleet bucket without changing this API.
 * The write view is not a separate authorization grant.
 *
 * ### Store metadata
 * **Example:** Write an expiring value in a Worker handler
 * ```typescript
 * const kv = yield* Celld.KV.WriteNamespace(namespace);
 * const fetch = Effect.gen(function* () {
 *   yield* kv.put("greeting", "hello", {
 *     metadata: { language: "en" }, expirationTtl: 120,
 *   });
 *   return HttpServerResponse.text("stored");
 * });
 * ```
 * Provide `Celld.KV.WriteNamespaceBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export const WriteNamespace = Binding.Service<WriteNamespace>(
  "Celld.KV.WriteNamespace",
);

export interface WriteNamespaceClient<Key extends string = string> {
  put(
    key: Key,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: NamespacePutOptions,
  ): Effect.Effect<void, NamespaceError, RuntimeContext>;
  delete(key: Key): Effect.Effect<void, NamespaceError, RuntimeContext>;
}
