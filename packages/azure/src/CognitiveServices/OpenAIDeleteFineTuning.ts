import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIDeleteFineTuningRequest extends Omit<
  authoring.DeleteFineTuningRequest,
  "endpoint"
> {}

/**
 * Delete one fine-tuning job of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningDeleteRole`, one per stack)
 * with exactly the data action `OpenAI/fine-tunes/delete`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIDeleteFineTuningHttp}.
 *
 * ### Calling OpenAIDeleteFineTuning
 * **Example:** OpenAIDeleteFineTuning from a Function
 * ```typescript
 * // init
 * const deleteFineTuning = yield* Azure.CognitiveServices.OpenAIDeleteFineTuning(account);
 *
 * // runtime
 * yield* deleteFineTuning({ fineTuningJobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIDeleteFineTuning extends Binding.Service<
  OpenAIDeleteFineTuning,
  "Azure.CognitiveServices.OpenAIDeleteFineTuning",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIDeleteFineTuningRequest,
    ) => Effect.Effect<
      authoring.DeleteFineTuningResponse,
      authoring.DeleteFineTuningError,
      RuntimeContext
    >
  >
> {}

export const OpenAIDeleteFineTuning = Binding.Service<OpenAIDeleteFineTuning>(
  "Azure.CognitiveServices.OpenAIDeleteFineTuning",
);
