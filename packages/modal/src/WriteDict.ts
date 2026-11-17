import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { Dict } from "./Dict.ts";
import type { WriteDictClient } from "./DictClient.ts";

export type { WriteDictClient } from "./DictClient.ts";

/**
 * Write a Modal Dict from any runtime: put, update, pop and clear. Keys and values are JSON.
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
 *     const dict = yield* Modal.WriteDict(Results);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* dict.put("last-run", { ok: true });
 *         return HttpServerResponse.text("saved");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Modal.WriteDictHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Dict
 */
export interface WriteDict extends Binding.Service<
  WriteDict,
  "Modal.WriteDict",
  (dict: Dict) => Effect.Effect<WriteDictClient>
> {}

export const WriteDict = Binding.Service<WriteDict>("Modal.WriteDict");
