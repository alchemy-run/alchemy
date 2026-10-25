import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICancelBatchRequest extends Omit<authoring.CancelBatchRequest, "endpoint"> {}

/**
 * Cancel one batch job of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIBatchCancelRole`, one per stack)
 * with exactly the data action `OpenAI/batches/cancel/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICancelBatchHttp}.
 *
 * ### Calling OpenAICancelBatch
 * **Example:** OpenAICancelBatch from a Function
 * ```typescript
 * // init
 * const cancelBatch = yield* Azure.CognitiveServices.OpenAICancelBatch(account);
 *
 * // runtime
 * yield* cancelBatch({ batchId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICancelBatch extends Binding.Service<
  OpenAICancelBatch,
  "Azure.CognitiveServices.OpenAICancelBatch",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICancelBatchRequest,
    ) => Effect.Effect<authoring.Batch, authoring.CancelBatchError, RuntimeContext>
  >
> {}

export const OpenAICancelBatch = Binding.Service<OpenAICancelBatch>(
  "Azure.CognitiveServices.OpenAICancelBatch",
);
