import type { ReadClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { KeyValue } from "./KeyValue.ts";
import type { Redis } from "./Redis.ts";

export type ReadKeyValueClient = ReadClient;

/**
 * Bind a Render {@link KeyValue} or {@link Redis} datastore with read-only access.
 *
 * Provide {@link ReadKeyValueHttp}.
 *
 * **Example:** Read a cached key
 * ```typescript
 * const kv = yield* Render.ReadKeyValue(cache);
 * const value = yield* kv.get("session:123");
 * ```
 *
 * @binding
 * @product Key Value
 * @category Storage & Databases
 */
export interface ReadKeyValue extends Binding.Service<
  ReadKeyValue,
  "Render.ReadKeyValue",
  (instance: KeyValue | Redis) => Effect.Effect<ReadKeyValueClient>
> {}

export const ReadKeyValue = Binding.Service<ReadKeyValue>("Render.ReadKeyValue");
