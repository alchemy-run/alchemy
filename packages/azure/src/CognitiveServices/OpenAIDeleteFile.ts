import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIDeleteFileRequest extends Omit<authoring.DeleteFileRequest, "endpoint"> {}

/**
 * Delete one file of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIFileDeleteRole`, one per stack)
 * with exactly the data action `OpenAI/files/delete`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIDeleteFileHttp}.
 *
 * ### Calling OpenAIDeleteFile
 * **Example:** OpenAIDeleteFile from a Function
 * ```typescript
 * // init
 * const deleteFile = yield* Azure.CognitiveServices.OpenAIDeleteFile(account);
 *
 * // runtime
 * yield* deleteFile({ fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIDeleteFile extends Binding.Service<
  OpenAIDeleteFile,
  "Azure.CognitiveServices.OpenAIDeleteFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIDeleteFileRequest,
    ) => Effect.Effect<authoring.FileDelete, authoring.DeleteFileError, RuntimeContext>
  >
> {}

export const OpenAIDeleteFile = Binding.Service<OpenAIDeleteFile>(
  "Azure.CognitiveServices.OpenAIDeleteFile",
);
