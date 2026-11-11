import type * as DO from "@distilled.cloud/digitalocean";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { InferenceKeyMissing, InferenceOptions } from "./InferenceBinding.ts";

/**
 * Embeds text as vectors (`/v1/embeddings`). Serverless Inference, from a runtime, with a model access key
 * the host receives as a secret.
 *
 * **Example:** From an App
 * ```typescript
 * export default class Api extends DigitalOcean.App<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const key = yield* Config.Redacted("DO_MODEL_KEY");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const embed = yield* DigitalOcean.Inference.CreateEmbedding({ key });
 *         const out = yield* embed({ model: "qwen3-embedding-0.6b", input: "hello" });
 *         return yield* HttpServerResponse.json(out);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(DigitalOcean.Inference.CreateEmbeddingHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Serverless Inference
 */
export interface CreateEmbedding extends Binding.Service<
  CreateEmbedding,
  "DigitalOcean.Inference.CreateEmbedding",
  (
    options: InferenceOptions,
  ) => Effect.Effect<
    (
      request: DO.CreateInferenceEmbeddingRequest,
    ) => Effect.Effect<
      DO.EmbeddingsResponse,
      DO.CreateInferenceEmbeddingError | InferenceKeyMissing,
      RuntimeContext
    >
  >
> {}

export const CreateEmbedding = Binding.Service<CreateEmbedding>(
  "DigitalOcean.Inference.CreateEmbedding",
);
