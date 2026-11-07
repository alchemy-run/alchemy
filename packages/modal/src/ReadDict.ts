import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dict } from "./Dict.ts";
import type { ReadDictClient } from "./DictClient.ts";

export type { ReadDictClient } from "./DictClient.ts";

/**
 * Read a Modal Dict from any runtime: get, contains, len and entries. Keys and values are JSON.
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
 *     const dict = yield* Modal.ReadDict(Results);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const last = yield* dict.get("last-run");
 *         return yield* HttpServerResponse.json(last ?? null);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.ReadDictHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dict
 */
export interface ReadDict extends Binding.Service<
  ReadDict,
  "Modal.ReadDict",
  (dict: Dict) => Effect.Effect<ReadDictClient>
> {}

export const ReadDict = Binding.Service<ReadDict>("Modal.ReadDict");
