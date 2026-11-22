import type * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateChatCompletionRequest extends Omit<
  inference.CreateChatCompletionRequest,
  "endpoint"
> {}

/**
 * Generate a chat completion with a chat model deployment (e.g. `gpt-4.1-mini`)
 * of an Azure OpenAI account. `deploymentId` is the deployment's name.
 *
 * Binding assigns a custom role (`AzureOpenAIChatCompletionRole`, one per stack)
 * with exactly the data action `OpenAI/deployments/chat/completions/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateChatCompletionHttp}.
 *
 * ### Calling OpenAICreateChatCompletion
 * **Example:** OpenAICreateChatCompletion from a Function
 * ```typescript
 * // init
 * const chat = yield* Azure.CognitiveServices.OpenAICreateChatCompletion(account);
 *
 * // runtime
 * const reply = yield* chat({
 *   deploymentId: "chat",
 *   messages: [{ role: "user", content: "Say hello" }],
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateChatCompletion extends Binding.Service<
  OpenAICreateChatCompletion,
  "Azure.CognitiveServices.OpenAICreateChatCompletion",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateChatCompletionRequest,
    ) => Effect.Effect<
      inference.CreateChatCompletionResponse2,
      inference.CreateChatCompletionError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateChatCompletion = Binding.Service<OpenAICreateChatCompletion>(
  "Azure.CognitiveServices.OpenAICreateChatCompletion",
);
