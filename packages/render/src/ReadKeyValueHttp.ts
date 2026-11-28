import * as Layer from "effect/Layer";
import { makeKeyValueBinding } from "./KeyValueBinding.ts";
import { makeReadKeyValueClient } from "./KeyValueHttp.ts";
import { ReadKeyValue } from "./ReadKeyValue.ts";

/**
 * Runtime/HTTP implementation of {@link ReadKeyValue}.
 *
 * **Example:** Provide `ReadKeyValueHttp`
 * ```typescript
 * Effect.gen(function* () {
 *   const kv = yield* Render.ReadKeyValue(cache);
 *   return yield* kv.get("greeting");
 * }).pipe(Effect.provide(Render.ReadKeyValueHttp));
 * ```
 *
 * @layer
 * @product Key Value
 * @provides Render.ReadKeyValue
 */
export const ReadKeyValueHttp = Layer.effect(
  ReadKeyValue,
  makeKeyValueBinding({
    makeClient: makeReadKeyValueClient,
  }),
);
