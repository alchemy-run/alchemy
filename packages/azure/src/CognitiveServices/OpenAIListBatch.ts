import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIListBatchRequest extends Omit<authoring.ListBatchRequest, "endpoint"> {}

/**
 * List the batch jobs of an Azure OpenAI account (one page per call; pass
 * `after` for the next page).
 *
 * Binding assigns a custom role (`AzureOpenAIBatchReadRole`, one per stack, shared with `OpenAIGetBatch`)
 * with exactly the data action `OpenAI/batches/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIListBatchHttp}.
 *
 * ### Calling OpenAIListBatch
 * **Example:** OpenAIListBatch from a Function
 * ```typescript
 * // init
 * const listBatches = yield* Azure.CognitiveServices.OpenAIListBatch(account);
 *
 * // runtime
 * const { data, has_more } = yield* listBatches({ limit: 20 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIListBatch extends Binding.Service<
  OpenAIListBatch,
  "Azure.CognitiveServices.OpenAIListBatch",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: OpenAIListBatchRequest,
    ) => Effect.Effect<authoring.BatchesList, authoring.ListBatchError, RuntimeContext>
  >
> {}

export const OpenAIListBatch = Binding.Service<OpenAIListBatch>(
  "Azure.CognitiveServices.OpenAIListBatch",
);
