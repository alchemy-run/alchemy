import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIGetFineTuningCheckpointsRequest extends Omit<
  authoring.GetFineTuningCheckpointsRequest,
  "endpoint"
> {}

/**
 * List the checkpoints of one fine-tuning job of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIFineTuningReadRole`, one per stack, shared with `OpenAIListFineTuning`, `OpenAIGetFineTuning`, `OpenAIGetFineTuningEvents`)
 * with exactly the data action `OpenAI/fine-tunes/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIGetFineTuningCheckpointsHttp}.
 *
 * ### Calling OpenAIGetFineTuningCheckpoints
 * **Example:** OpenAIGetFineTuningCheckpoints from a Function
 * ```typescript
 * // init
 * const getFineTuningCheckpoints = yield* Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints(account);
 *
 * // runtime
 * const { data } = yield* getFineTuningCheckpoints({ fineTuningJobId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIGetFineTuningCheckpoints extends Binding.Service<
  OpenAIGetFineTuningCheckpoints,
  "Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIGetFineTuningCheckpointsRequest,
    ) => Effect.Effect<
      authoring.FineTuningJobCheckpointList,
      authoring.GetFineTuningCheckpointsError,
      RuntimeContext
    >
  >
> {}

export const OpenAIGetFineTuningCheckpoints = Binding.Service<OpenAIGetFineTuningCheckpoints>(
  "Azure.CognitiveServices.OpenAIGetFineTuningCheckpoints",
);
