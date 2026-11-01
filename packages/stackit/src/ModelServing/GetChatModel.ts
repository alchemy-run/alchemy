import type * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type GetChatModelRequest = modelServing.GetChatModelRequest;

/**
 * Runtime binding for `getChatModel`: read a chat model's context length and tags, to fit a
 * prompt to it. It takes no resource, because the catalogue belongs to the region. Provide
 * {@link GetChatModelHttp}. `modelId` is the model's `id` from `ListModels`, not its name.
 *
 * Access: none. The spec turns authorization off for this operation, so no role is granted;
 * the host still gets a service account and key, because the API takes a STACKIT access token.
 *
 * ### Reading a Chat Model
 * **Example:** Read a model's context length
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
 *     const binding = yield* Stackit.ModelServing.GetChatModel();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { model } = yield* binding({ regionId: "eu01", modelId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ contextLength: model.contextLength });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.GetChatModelHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface GetChatModel extends Binding.Service<
  GetChatModel,
  "Stackit.ModelServing.GetChatModel",
  () => Effect.Effect<
    (
      request: GetChatModelRequest,
    ) => Effect.Effect<
      modelServing.GetChatModelResponse,
      modelServing.GetChatModelError,
      RuntimeContext
    >
  >
> {}

export const GetChatModel = Binding.Service<GetChatModel>("Stackit.ModelServing.GetChatModel");
