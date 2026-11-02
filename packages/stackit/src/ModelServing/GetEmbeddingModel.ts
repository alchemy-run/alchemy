import type * as modelServing from "@distilled.cloud/stackit/model_serving";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type GetEmbeddingModelRequest = modelServing.GetEmbeddingModelRequest;

/**
 * Runtime binding for `getEmbeddingModel`: read an embedding model's output dimension, to size
 * a vector index. It takes no resource, because the catalogue belongs to the region. Provide
 * {@link GetEmbeddingModelHttp}. `modelId` is the model's `id` from `ListModels`, not its
 * name.
 *
 * Access: none. The spec turns authorization off for this operation, so no role is granted;
 * the host still gets a service account and key, because the API takes a STACKIT access token.
 *
 * ### Reading an Embedding Model
 * **Example:** Read a model's output dimension
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
 *     const binding = yield* Stackit.ModelServing.GetEmbeddingModel();
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { model } = yield* binding({ regionId: "eu01", modelId: "00000000-0000-0000-0000-000000000000" });
 *         return yield* HttpServerResponse.json({ dimension: model.outputDimension });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.GetEmbeddingModelHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface GetEmbeddingModel extends Binding.Service<
  GetEmbeddingModel,
  "Stackit.ModelServing.GetEmbeddingModel",
  () => Effect.Effect<
    (
      request: GetEmbeddingModelRequest,
    ) => Effect.Effect<
      modelServing.GetEmbeddingsModelResp,
      modelServing.GetEmbeddingModelError,
      RuntimeContext
    >
  >
> {}

export const GetEmbeddingModel = Binding.Service<GetEmbeddingModel>(
  "Stackit.ModelServing.GetEmbeddingModel",
);
