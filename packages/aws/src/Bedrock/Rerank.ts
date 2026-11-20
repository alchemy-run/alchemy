import * as bedrock from "@distilled.cloud/aws/bedrock-agent-runtime";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { AWSEnvironment } from "../Environment.ts";
import { bedrockModelArns } from "./ModelArns.ts";

/**
 * The `Rerank` request. The reranker model is referenced inside
 * `rerankingConfiguration.bedrockRerankingConfiguration.modelConfiguration.modelArn`
 * — pass the full foundation-model ARN of one of the bound models there.
 */
export interface RerankRequest extends bedrock.RerankRequest {}

/**
 * Runtime binding for `bedrock-agent-runtime:Rerank` — re-order a list of
 * candidate documents by semantic relevance to a query using a Bedrock
 * reranker model (e.g. `amazon.rerank-v1:0`, `cohere.rerank-v3-5:0`).
 *
 * Bind one or more reranker model references inside a function runtime. The
 * binding grants the function `bedrock:Rerank` (which AWS authorizes only
 * against `*`) plus `bedrock:InvokeModel` scoped to exactly the bound
 * models.
 *
 * ### Reranking Documents
 * **Example:** Rerank Inline Text Documents
 * ```typescript
 * // init
 * const rerank = yield* Bedrock.Rerank("amazon.rerank-v1:0");
 *
 * // runtime
 * const result = yield* rerank({
 *   queries: [{ type: "TEXT", textQuery: { text: "What is Alchemy?" } }],
 *   sources: docs.map((text) => ({
 *     type: "INLINE",
 *     inlineDocumentSource: { type: "TEXT", textDocument: { text } },
 *   })),
 *   rerankingConfiguration: {
 *     type: "BEDROCK_RERANKING_MODEL",
 *     bedrockRerankingConfiguration: {
 *       modelConfiguration: {
 *         modelArn: `arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0`,
 *       },
 *     },
 *   },
 * });
 * const best = result.results[0]; // { index, relevanceScore }
 * ```
 *
 * @binding
 */
export interface Rerank extends Binding.Service<
  Rerank,
  "AWS.Bedrock.Rerank",
  (
    model: string,
    ...additionalModels: string[]
  ) => Effect.Effect<
    (request: RerankRequest) => Effect.Effect<bedrock.RerankResponse, bedrock.RerankError>
  >
> {}
export const Rerank = Binding.Service<Rerank>("AWS.Bedrock.Rerank");

// Bespoke (not the shared model-scoped scaffold): Rerank authorizes the
// `bedrock:Rerank` action only against `*`, alongside model-scoped
// `bedrock:InvokeModel`, and the model is referenced inside
// `rerankingConfiguration` rather than a top-level `modelId`.
export const RerankHttp = Layer.effect(
  Rerank,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const rerank = yield* AWSBindings.withCredentials(bedrock.rerank);

    return Effect.fn(function* (model: string, ...additionalModels: string[]) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { accountId, region } = yield* AWSEnvironment.current as unknown as Effect.Effect<{
          accountId: string;
          region: string;
        }>;
        // Sort so the binding identity (SID + ARN list) is deterministic
        // regardless of argument order.
        const sorted = [...new Set([model, ...additionalModels])].sort();
        yield* bind`AWS.Bedrock.Rerank(${sorted.join(",")})`({
          policyStatements: [
            {
              // bedrock:Rerank does not support resource-level scoping.
              Effect: "Allow",
              Action: ["bedrock:Rerank"],
              Resource: ["*"],
            },
            {
              Effect: "Allow",
              Action: ["bedrock:InvokeModel"],
              Resource: [
                ...new Set(sorted.flatMap((id) => bedrockModelArns(region, accountId, id))),
              ],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Bedrock.Rerank(${model})`)(function* (request: RerankRequest) {
        return yield* rerank(request);
      });
    });
  }),
);
