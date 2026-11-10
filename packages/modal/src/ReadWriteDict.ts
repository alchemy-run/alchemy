import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dict } from "./Dict.ts";
import type { ReadWriteDictClient } from "./DictClient.ts";

export type { ReadWriteDictClient } from "./DictClient.ts";

/**
 * Read and write a Modal Dict from any runtime. Keys and values are JSON.
 *
 * ### Bind a dict
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Modal from "@alchemy.run/modal";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { Results } from "./Storage.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const dict = yield* Modal.ReadWriteDict(Results);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* dict.put("hits", ((yield* dict.get<number>("hits")) ?? 0) + 1);
 *         return yield* HttpServerResponse.json({ hits: yield* dict.get("hits") });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadWriteDictHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dict
 */
export interface ReadWriteDict extends Binding.Service<
  ReadWriteDict,
  "Modal.ReadWriteDict",
  (dict: Dict) => Effect.Effect<ReadWriteDictClient>
> {}

export const ReadWriteDict = Binding.Service<ReadWriteDict>("Modal.ReadWriteDict");
