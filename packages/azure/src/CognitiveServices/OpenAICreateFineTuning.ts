import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateFineTuningRequest extends Omit<
  authoring.CreateFineTuningRequest,
  "endpoint"
> {}

/**
 * Start a fine-tuning job on an Azure OpenAI account from an uploaded
 * `fine-tune` training file.
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningWriteRole`, one per stack, shared with `OpenAICancelFineTuning`)
 * with exactly the data action `OpenAI/fine-tunes/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateFineTuningHttp}.
 *
 * ### Calling OpenAICreateFineTuning
 * **Example:** OpenAICreateFineTuning from a Function
 * ```typescript
 * // init
 * const createFineTuning = yield* Azure.CognitiveServices.OpenAICreateFineTuning(account);
 *
 * // runtime
 * const job = yield* createFineTuning({
 *   model: "gpt-4.1-mini-2025-04-14",
 *   training_file: trainingFileId,
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateFineTuning extends Binding.Service<
  OpenAICreateFineTuning,
  "Azure.CognitiveServices.OpenAICreateFineTuning",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateFineTuningRequest,
    ) => Effect.Effect<
      authoring.CreateFineTuningResponse,
      authoring.CreateFineTuningError,
      RuntimeContext
    >
  >
> {}

export const OpenAICreateFineTuning = Binding.Service<OpenAICreateFineTuning>(
  "Azure.CognitiveServices.OpenAICreateFineTuning",
);
