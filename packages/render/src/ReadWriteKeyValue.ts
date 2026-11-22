import type { ReadWriteClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { KeyValue } from "./KeyValue.ts";
import type { Redis } from "./Redis.ts";

export type ReadWriteKeyValueClient = ReadWriteClient;

/**
 * Bind a Render {@link KeyValue} or {@link Redis} datastore with full read +
 * write access (`get`, `set`, `del`, hashes, lists, sets, sorted sets, `send`).
 *
 * Provide {@link ReadWriteKeyValueHttp}.
 *
 * **Example:** Read and write a key
 * ```typescript
 * const kv = yield* Render.ReadWriteKeyValue(cache);
 * yield* kv.set("greeting", "hello");
 * const value = yield* kv.get("greeting");
 * ```
 *
 * @binding
 * @product Key Value
 * @category Storage & Databases
 */
export interface ReadWriteKeyValue extends Binding.Service<
  ReadWriteKeyValue,
  "Render.ReadWriteKeyValue",
  (instance: KeyValue | Redis) => Effect.Effect<ReadWriteKeyValueClient>
> {}

export const ReadWriteKeyValue = Binding.Service<ReadWriteKeyValue>("Render.ReadWriteKeyValue");
