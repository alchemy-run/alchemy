import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIListModelsRequest extends Omit<authoring.ListModelsRequest, "endpoint"> {}

/**
 * List the base and fine-tuned models an Azure OpenAI account can use.
 *
 * Binding assigns a custom role (`AzureOpenAIModelReadRole`, one per stack, shared with `OpenAIGetModel`)
 * with exactly the data action `OpenAI/models/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIListModelsHttp}.
 *
 * ### Calling OpenAIListModels
 * **Example:** OpenAIListModels from a Function
 * ```typescript
 * // init
 * const listModels = yield* Azure.CognitiveServices.OpenAIListModels(account);
 *
 * // runtime
 * const { data } = yield* listModels();
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIListModels extends Binding.Service<
  OpenAIListModels,
  "Azure.CognitiveServices.OpenAIListModels",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: OpenAIListModelsRequest,
    ) => Effect.Effect<authoring.ModelList, authoring.ListModelsError, RuntimeContext>
  >
> {}

export const OpenAIListModels = Binding.Service<OpenAIListModels>(
  "Azure.CognitiveServices.OpenAIListModels",
);
