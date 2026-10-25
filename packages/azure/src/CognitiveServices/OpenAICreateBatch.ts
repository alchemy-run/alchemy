import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICreateBatchRequest extends Omit<authoring.CreateBatchRequest, "endpoint"> {}

/**
 * Start a batch job from an uploaded `batch` file on a `GlobalBatch`
 * deployment of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIBatchCreateRole`, one per stack)
 * with exactly the data action `OpenAI/batches/action`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICreateBatchHttp}.
 *
 * ### Calling OpenAICreateBatch
 * **Example:** OpenAICreateBatch from a Function
 * ```typescript
 * // init
 * const createBatch = yield* Azure.CognitiveServices.OpenAICreateBatch(account);
 *
 * // runtime
 * const batch = yield* createBatch({
 *   input_file_id: file.id!,
 *   completion_window: "24h",
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICreateBatch extends Binding.Service<
  OpenAICreateBatch,
  "Azure.CognitiveServices.OpenAICreateBatch",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICreateBatchRequest,
    ) => Effect.Effect<authoring.Batch, authoring.CreateBatchError, RuntimeContext>
  >
> {}

export const OpenAICreateBatch = Binding.Service<OpenAICreateBatch>(
  "Azure.CognitiveServices.OpenAICreateBatch",
);
