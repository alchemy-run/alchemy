import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIGetModelRequest extends Omit<authoring.GetModelRequest, "endpoint"> {}

/**
 * Read one model (base or fine-tuned) of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIModelReadRole`, one per stack, shared with `OpenAIListModels`)
 * with exactly the data action `OpenAI/models/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIGetModelHttp}.
 *
 * ### Calling OpenAIGetModel
 * **Example:** OpenAIGetModel from a Function
 * ```typescript
 * // init
 * const getModel = yield* Azure.CognitiveServices.OpenAIGetModel(account);
 *
 * // runtime
 * const model = yield* getModel({ modelId: "gpt-4.1-mini-2025-04-14" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIGetModel extends Binding.Service<
  OpenAIGetModel,
  "Azure.CognitiveServices.OpenAIGetModel",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIGetModelRequest,
    ) => Effect.Effect<authoring.Model, authoring.GetModelError, RuntimeContext>
  >
> {}

export const OpenAIGetModel = Binding.Service<OpenAIGetModel>(
  "Azure.CognitiveServices.OpenAIGetModel",
);
