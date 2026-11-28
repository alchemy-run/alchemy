import type { ReadWriteClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { KeyValue } from "./KeyValue.ts";

export type ReadWriteKeyValueClient = ReadWriteClient;

/**
 * Bind a Render {@link KeyValue} datastore with full read +
 * write access (`get`, `set`, `del`, hashes, lists, sets, sorted sets, `send`).
 *
 * Provide {@link ReadWriteKeyValueHttp}.
 *
 * **Example:** Read and write Key Value on a WebService
 * ```typescript
 * const api = yield* Render.WebService(
 *   "Api",
 *   {
 *     plan: "free",
 *     region: "oregon",
 *     runtimeSource: { image: { imagePath: "docker.io/nginxdemos/hello", tag: "plain-text" } },
 *   },
 *   Effect.gen(function* () {
 *     const kv = yield* Render.ReadWriteKeyValue(cache);
 *     return { kv };
 *   }).pipe(Effect.provide(Render.ReadWriteKeyValueHttp)),
 * );
 * ```
 *
 * @binding
 * @product Key Value
 * @category Storage & Databases
 */
export interface ReadWriteKeyValue extends Binding.Service<
  ReadWriteKeyValue,
  "Render.ReadWriteKeyValue",
  (instance: KeyValue) => Effect.Effect<ReadWriteKeyValueClient>
> {}

export const ReadWriteKeyValue = Binding.Service<ReadWriteKeyValue>("Render.ReadWriteKeyValue");
