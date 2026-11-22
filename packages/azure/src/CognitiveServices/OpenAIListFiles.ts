import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIListFilesRequest extends Omit<authoring.ListFilesRequest, "endpoint"> {}

/**
 * List the files of an Azure OpenAI account (training data, batch input,
 * and service-generated results).
 *
 * Binding assigns a custom role (`AzureOpenAIFileReadRole`, one per stack, shared with `OpenAIGetFile`, `OpenAIGetFileContent`)
 * with exactly the data action `OpenAI/files/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIListFilesHttp}.
 *
 * ### Calling OpenAIListFiles
 * **Example:** OpenAIListFiles from a Function
 * ```typescript
 * // init
 * const listFiles = yield* Azure.CognitiveServices.OpenAIListFiles(account);
 *
 * // runtime
 * const { data } = yield* listFiles({ purpose: "batch" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIListFiles extends Binding.Service<
  OpenAIListFiles,
  "Azure.CognitiveServices.OpenAIListFiles",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request?: OpenAIListFilesRequest,
    ) => Effect.Effect<authoring.FileList, authoring.ListFilesError, RuntimeContext>
  >
> {}

export const OpenAIListFiles = Binding.Service<OpenAIListFiles>(
  "Azure.CognitiveServices.OpenAIListFiles",
);
