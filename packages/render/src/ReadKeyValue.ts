import type { ReadClient } from "@alchemy.run/redis";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { KeyValue } from "./KeyValue.ts";

export type ReadKeyValueClient = ReadClient;

/**
 * Bind a Render {@link KeyValue} datastore with read-only access.
 *
 * Provide {@link ReadKeyValueHttp}.
 *
 * **Example:** Read from Key Value on a WebService
 * ```typescript
 * const api = yield* Render.WebService(
 *   "Api",
 *   {
 *     plan: "free",
 *     region: "oregon",
 *     runtimeSource: { image: { imagePath: "docker.io/nginxdemos/hello", tag: "plain-text" } },
 *   },
 *   Effect.gen(function* () {
 *     const kv = yield* Render.ReadKeyValue(cache);
 *     return { kv };
 *   }).pipe(Effect.provide(Render.ReadKeyValueHttp)),
 * );
 * ```
 *
 * @binding
 * @product Key Value
 * @category Storage & Databases
 */
export interface ReadKeyValue extends Binding.Service<
  ReadKeyValue,
  "Render.ReadKeyValue",
  (instance: KeyValue) => Effect.Effect<ReadKeyValueClient>
> {}

export const ReadKeyValue = Binding.Service<ReadKeyValue>("Render.ReadKeyValue");
