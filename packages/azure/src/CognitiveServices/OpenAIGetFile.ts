import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIGetFileRequest extends Omit<authoring.GetFileRequest, "endpoint"> {}

/**
 * Read the details (status, size, purpose) of one file of an Azure OpenAI
 * account.
 *
 * Binding assigns a custom role (`AzureOpenAIFileReadRole`, one per stack, shared with `OpenAIListFiles`, `OpenAIGetFileContent`)
 * with exactly the data action `OpenAI/files/read`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIGetFileHttp}.
 *
 * ### Calling OpenAIGetFile
 * **Example:** OpenAIGetFile from a Function
 * ```typescript
 * // init
 * const getFile = yield* Azure.CognitiveServices.OpenAIGetFile(account);
 *
 * // runtime
 * const file = yield* getFile({ fileId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIGetFile extends Binding.Service<
  OpenAIGetFile,
  "Azure.CognitiveServices.OpenAIGetFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIGetFileRequest,
    ) => Effect.Effect<authoring.File, authoring.GetFileError, RuntimeContext>
  >
> {}

export const OpenAIGetFile = Binding.Service<OpenAIGetFile>(
  "Azure.CognitiveServices.OpenAIGetFile",
);
