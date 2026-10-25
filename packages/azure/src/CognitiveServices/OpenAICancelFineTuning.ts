import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICancelFineTuningRequest extends Omit<
  authoring.CancelFineTuningRequest,
  "endpoint"
> {}

/**
 * Cancel one fine-tuning job of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningWriteRole`, one per stack, shared with `OpenAICreateFineTuning`)
 * with exactly the data action `OpenAI/fine-tunes/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICancelFineTuningHttp}.
 *
 * ### Calling OpenAICancelFineTuning
 * **Example:** OpenAICancelFineTuning from a Function
 * ```typescript
 * // init
 * const cancelFineTuning = yield* Azure.CognitiveServices.OpenAICancelFineTuning(account);
 *
 * // runtime
 * yield* cancelFineTuning({ fineTuningJobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICancelFineTuning extends Binding.Service<
  OpenAICancelFineTuning,
  "Azure.CognitiveServices.OpenAICancelFineTuning",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICancelFineTuningRequest,
    ) => Effect.Effect<authoring.FineTuningJob, authoring.CancelFineTuningError, RuntimeContext>
  >
> {}

export const OpenAICancelFineTuning = Binding.Service<OpenAICancelFineTuning>(
  "Azure.CognitiveServices.OpenAICancelFineTuning",
);
