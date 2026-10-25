import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIListFineTuningRequest extends Omit<
  authoring.ListFineTuningRequest,
  "endpoint"
> {}

/**
 * List the fine-tuning jobs of an Azure OpenAI account (one page per call;
 * pass `after` for the next page).
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningReadRole`, one per stack, shared with `OpenAIGetFineTuning`, `OpenAIGetFineTuningEvents`, `OpenAIGetFineTuningCheckpoints`)
 * with exactly the data action `OpenAI/fine-tunes/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIListFineTuningHttp}.
 *
 * ### Calling OpenAIListFineTuning
 * **Example:** OpenAIListFineTuning from a Function
 * ```typescript
 * // init
 * const listFineTuning = yield* Azure.CognitiveServices.OpenAIListFineTuning(account);
 *
 * // runtime
 * const { data } = yield* listFineTuning({ limit: 10 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIListFineTuning extends Binding.Service<
  OpenAIListFineTuning,
  "Azure.CognitiveServices.OpenAIListFineTuning",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: OpenAIListFineTuningRequest,
    ) => Effect.Effect<authoring.FineTuningJobList, authoring.ListFineTuningError, RuntimeContext>
  >
> {}

export const OpenAIListFineTuning = Binding.Service<OpenAIListFineTuning>(
  "Azure.CognitiveServices.OpenAIListFineTuning",
);
