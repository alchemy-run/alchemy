import type * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateEmbeddingRequest extends Omit<
  inference.CreateEmbeddingRequest,
  "endpoint"
> {}

/**
 * Embed text with an embeddings model deployment (e.g.
 * `text-embedding-3-small`) of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIEmbeddingRole`, one per stack)
 * with exactly the data action `OpenAI/deployments/embeddings/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateEmbeddingHttp}.
 *
 * ### Calling OpenAICreateEmbedding
 * **Example:** OpenAICreateEmbedding from a Function
 * ```typescript
 * // init
 * const embed = yield* Azure.CognitiveServices.OpenAICreateEmbedding(account);
 *
 * // runtime
 * const { data } = yield* embed({ deploymentId: "embeddings", input: ["hello", "world"] });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateEmbedding extends Binding.Service<
  OpenAICreateEmbedding,
  "Azure.CognitiveServices.OpenAICreateEmbedding",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateEmbeddingRequest,
    ) => Effect.Effect<
      inference.CreateEmbeddingResponse,
      inference.CreateEmbeddingError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateEmbedding = Binding.Service<OpenAICreateEmbedding>(
  "Azure.CognitiveServices.OpenAICreateEmbedding",
);
