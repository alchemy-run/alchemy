import type * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateImageGenerationRequest extends Omit<
  inference.CreateImageGenerationRequest,
  "endpoint"
> {}

/**
 * Generate images with an image model deployment (e.g. `dall-e-3`) of an
 * Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIImageGenerationRole`, one per stack)
 * with exactly the data action `OpenAI/images/generations/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateImageGenerationHttp}.
 *
 * ### Calling OpenAICreateImageGeneration
 * **Example:** OpenAICreateImageGeneration from a Function
 * ```typescript
 * // init
 * const generateImage = yield* Azure.CognitiveServices.OpenAICreateImageGeneration(account);
 *
 * // runtime
 * const { data } = yield* generateImage({ deploymentId: "images", prompt: "a red fox", n: 1 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateImageGeneration extends Binding.Service<
  OpenAICreateImageGeneration,
  "Azure.CognitiveServices.OpenAICreateImageGeneration",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateImageGenerationRequest,
    ) => Effect.Effect<
      inference.GenerateImagesResponse,
      inference.CreateImageGenerationError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateImageGeneration = Binding.Service<OpenAICreateImageGeneration>(
  "Azure.CognitiveServices.OpenAICreateImageGeneration",
);
