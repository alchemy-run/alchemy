import * as Layer from "effect/Layer";
import { makeKeyValueBinding } from "./KeyValueBinding.ts";
import { makeReadWriteKeyValueClient } from "./KeyValueHttp.ts";
import { ReadWriteKeyValue } from "./ReadWriteKeyValue.ts";

/**
 * Runtime/HTTP implementation of {@link ReadWriteKeyValue}.
 *
 * **Example:** Provide `ReadWriteKeyValueHttp`
 * ```typescript
 * Effect.gen(function* () {
 *   const kv = yield* Render.ReadWriteKeyValue(cache);
 *   yield* kv.set("greeting", "hello");
 *   return yield* kv.get("greeting");
 * }).pipe(Effect.provide(Render.ReadWriteKeyValueHttp));
 * ```
 *
 * @layer
 * @product Key Value
 * @provides Render.ReadWriteKeyValue
 */
export const ReadWriteKeyValueHttp = Layer.effect(
  ReadWriteKeyValue,
  makeKeyValueBinding({
    makeClient: makeReadWriteKeyValueClient,
  }),
);
