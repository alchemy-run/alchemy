import type * as inference from "@distilled.cloud/azure/cognitiveservices-openai-inference";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateCompletionRequest extends Omit<
  inference.CreateCompletionRequest,
  "endpoint"
> {}

/**
 * Complete a prompt with a legacy completions model deployment (e.g.
 * `gpt-35-turbo-instruct`) of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAICompletionRole`, one per stack)
 * with exactly the data action `OpenAI/deployments/completions/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateCompletionHttp}.
 *
 * ### Calling OpenAICreateCompletion
 * **Example:** OpenAICreateCompletion from a Function
 * ```typescript
 * // init
 * const complete = yield* Azure.CognitiveServices.OpenAICreateCompletion(account);
 *
 * // runtime
 * const completion = yield* complete({ deploymentId: "instruct", prompt: "Once upon a time" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateCompletion extends Binding.Service<
  OpenAICreateCompletion,
  "Azure.CognitiveServices.OpenAICreateCompletion",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateCompletionRequest,
    ) => Effect.Effect<
      inference.CreateCompletionResponse,
      inference.CreateCompletionError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateCompletion = Binding.Service<OpenAICreateCompletion>(
  "Azure.CognitiveServices.OpenAICreateCompletion",
);
