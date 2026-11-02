import type * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type ListModelsRequest = modelServing.ListModelsRequest;

/**
 * Runtime binding for `listModels`: list the shared models of a region, with each one's type,
 * category and name. It takes no resource, because the catalogue belongs to the region.
 * Provide {@link ListModelsHttp}. A model's `name` is what inference requests pass as `model`.
 *
 * Access: none. The spec turns authorization off for this operation, so no role is granted;
 * the host still gets a service account and key, because the API takes a STACKIT access token.
 *
 * ### Listing Models
 * **Example:** List the chat models in a region
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelServing.ListModels();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { models } = yield* binding({ regionId: "eu01" });
 *         const chat = models.filter((model) => model.type === "chat");
 *         return yield* HttpServerResponse.json(chat.map((model) => model.name));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.ListModelsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface ListModels extends Binding.Service<
  ListModels,
  "Stackit.ModelServing.ListModels",
  () => Effect.Effect<
    (
      request: ListModelsRequest,
    ) => Effect.Effect<
      modelServing.ListModelsResponse,
      modelServing.ListModelsError,
      RuntimeContext
    >
  >
> {}

export const ListModels = Binding.Service<ListModels>("Stackit.ModelServing.ListModels");
