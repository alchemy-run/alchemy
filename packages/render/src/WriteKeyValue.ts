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
 * **Example:** Write to Key Value on a WebService
 * ```typescript
 * const api = yield* Render.WebService(
 *   "Api",
 *   {
 *     plan: "free",
 *     region: "oregon",
 *     runtimeSource: { image: { imagePath: "docker.io/nginxdemos/hello", tag: "plain-text" } },
 *   },
 *   Effect.gen(function* () {
 *     const kv = yield* Render.WriteKeyValue(cache);
 *     return { kv };
 *   }).pipe(Effect.provide(Render.WriteKeyValueHttp)),
 * );
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
