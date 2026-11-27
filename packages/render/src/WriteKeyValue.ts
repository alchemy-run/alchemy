import type { WriteClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { KeyValue } from "./KeyValue.ts";

export type WriteKeyValueClient = WriteClient;

/**
 * Bind a Render {@link KeyValue} datastore with write access.
 *
 * Provide {@link WriteKeyValueHttp}.
 *
 * **Example:** Write a key with TTL
 * ```typescript
 * const kv = yield* Render.WriteKeyValue(cache);
 * yield* kv.set("session:123", "ok", { ex: 60 });
 * ```
 *
 * @binding
 * @product Key Value
 * @category Storage & Databases
 */
export interface WriteKeyValue extends Binding.Service<
  WriteKeyValue,
  "Render.WriteKeyValue",
  (instance: KeyValue) => Effect.Effect<WriteKeyValueClient>
> {}

export const WriteKeyValue = Binding.Service<WriteKeyValue>("Render.WriteKeyValue");
