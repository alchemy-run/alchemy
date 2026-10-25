import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIGetFineTuningEventsRequest extends Omit<
  authoring.GetFineTuningEventsRequest,
  "endpoint"
> {}

/**
 * List the events of one fine-tuning job of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningReadRole`, one per stack, shared with `OpenAIListFineTuning`, `OpenAIGetFineTuning`, `OpenAIGetFineTuningCheckpoints`)
 * with exactly the data action `OpenAI/fine-tunes/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIGetFineTuningEventsHttp}.
 *
 * ### Calling OpenAIGetFineTuningEvents
 * **Example:** OpenAIGetFineTuningEvents from a Function
 * ```typescript
 * // init
 * const getFineTuningEvents = yield* Azure.CognitiveServices.OpenAIGetFineTuningEvents(account);
 *
 * // runtime
 * const { data } = yield* getFineTuningEvents({ fineTuningJobId, limit: 20 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIGetFineTuningEvents extends Binding.Service<
  OpenAIGetFineTuningEvents,
  "Azure.CognitiveServices.OpenAIGetFineTuningEvents",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIGetFineTuningEventsRequest,
    ) => Effect.Effect<
      authoring.FineTuningJobEventList,
      authoring.GetFineTuningEventsError,
      RuntimeContext
    >
  >
> {}

export const OpenAIGetFineTuningEvents = Binding.Service<OpenAIGetFineTuningEvents>(
  "Azure.CognitiveServices.OpenAIGetFineTuningEvents",
);
