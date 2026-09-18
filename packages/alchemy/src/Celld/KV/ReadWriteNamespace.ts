import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Namespace } from "./Namespace.ts";
import type { ReadNamespaceClient } from "./ReadNamespace.ts";
import type { WriteNamespaceClient } from "./WriteNamespace.ts";

export interface ReadWriteNamespace extends Binding.Service<
  ReadWriteNamespace,
  "Celld.KV.ReadWriteNamespace",
  (namespace: Namespace) => Effect.Effect<ReadWriteNamespaceClient>
> {}

/**
 * Read and write a Celld KV namespace using a native Worker binding.
 * Celld 0.5 serializes namespace writes through one writer, has no read cache,
 * and accepts only strings and byte buffers for writes, not streams or blobs.
 * Access levels are TypeScript views rather than native authorization grants.
 *
 * ### Read after writing
 * **Example:** Use a combined namespace client in a Worker handler
 * ```typescript
 * const kv = yield* Celld.KV.ReadWriteNamespace(namespace);
 * const fetch = Effect.gen(function* () {
 *   yield* kv.put("greeting", "hello");
 *   return HttpServerResponse.text((yield* kv.get("greeting")) ?? "missing");
 * });
 * ```
 * Provide `Celld.KV.ReadWriteNamespaceBinding` on the Worker's initialization effect.
 *
 * @binding
 * @product KV
 * @category Storage & Databases
 */
export const ReadWriteNamespace = Binding.Service<ReadWriteNamespace>(
  "Celld.KV.ReadWriteNamespace",
);

export interface ReadWriteNamespaceClient<Key extends string = string>
  extends ReadNamespaceClient<Key>, WriteNamespaceClient<Key> {}
