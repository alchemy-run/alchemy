import type * as inference from "@distilled.cloud/stackit/model_serving_inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Token } from "./Token.ts";

export type CreateEmbeddingsRequest = inference.CreateEmbeddingsRequest;

/**
 * Runtime binding for the OpenAI-compatible `POST /v1/embeddings`: turn text, or text and
 * images, into vectors. Bind it to a {@link Token} and provide {@link CreateEmbeddingsHttp}.
 * Inference is billed per million tokens of text.
 *
 * Access: the bound token itself, which reaches every shared model in its region. Nothing else
 * is granted, and no service account is created. The token's value reaches the host's env
 * `Redacted`.
 *
 * ### Creating Embeddings
 * **Example:** Embed a sentence from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ai = Stackit.ModelServing.Token("Ai", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const binding = yield* Stackit.ModelServing.CreateEmbeddings(yield* Ai);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { data } = yield* binding({
 *           model: "intfloat/e5-mistral-7b-instruct",
 *           input: ["A sentence to embed."],
 *         });
 *         return yield* HttpServerResponse.json({ dimension: data[0]?.embedding.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.ModelServing.CreateEmbeddingsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT AI Model Serving
 * @category ModelServing
 */
export interface CreateEmbeddings extends Binding.Service<
  CreateEmbeddings,
  "Stackit.ModelServing.CreateEmbeddings",
  (
    token: Token,
  ) => Effect.Effect<
    (
      request: CreateEmbeddingsRequest,
    ) => Effect.Effect<
      inference.EmbeddingsResponse,
      inference.CreateEmbeddingsError,
      RuntimeContext
    >
  >
> {}

export const CreateEmbeddings = Binding.Service<CreateEmbeddings>(
  "Stackit.ModelServing.CreateEmbeddings",
);
