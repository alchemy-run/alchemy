import * as Layer from "effect/Layer";
import { makeKeyValueBinding } from "./KeyValueBinding.ts";
import { makeWriteKeyValueClient } from "./KeyValueHttp.ts";
import { WriteKeyValue } from "./WriteKeyValue.ts";

/**
 * Runtime/HTTP implementation of {@link WriteKeyValue}.
 *
 * **Example:** Provide `WriteKeyValueHttp`
 * ```typescript
 * Effect.gen(function* () {
 *   const kv = yield* Render.WriteKeyValue(cache);
 *   yield* kv.set("greeting", "hello");
 * }).pipe(Effect.provide(Render.WriteKeyValueHttp));
 * ```
 *
 * @layer
 * @product Key Value
 * @provides Render.WriteKeyValue
 */
export const WriteKeyValueHttp = Layer.effect(
  WriteKeyValue,
  makeKeyValueBinding({
    makeClient: makeWriteKeyValueClient,
  }),
);
