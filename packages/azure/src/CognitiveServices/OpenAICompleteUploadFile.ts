import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAICompleteUploadFileRequest extends Omit<
  authoring.CompleteUploadFileRequest,
  "endpoint"
> {}

/**
 * Complete a multi-part upload of an Azure OpenAI account; the result
 * carries the new file.
 *
 * Binding assigns a custom role (`AzureOpenAIUploadWriteRole`, one per stack, shared with `OpenAIStartUploadFile`, `OpenAIUploadFilePart`, `OpenAICancelUploadFile`)
 * with exactly the data action `OpenAI/uploads/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAICompleteUploadFileHttp}.
 *
 * ### Calling OpenAICompleteUploadFile
 * **Example:** OpenAICompleteUploadFile from a Function
 * ```typescript
 * // init
 * const completeUpload = yield* Azure.CognitiveServices.OpenAICompleteUploadFile(account);
 *
 * // runtime
 * const done = yield* completeUpload({ uploadId: upload.id!, part_ids: [part.id!] });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAICompleteUploadFile extends Binding.Service<
  OpenAICompleteUploadFile,
  "Azure.CognitiveServices.OpenAICompleteUploadFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAICompleteUploadFileRequest,
    ) => Effect.Effect<authoring.UploadResource, authoring.CompleteUploadFileError, RuntimeContext>
  >
> {}

export const OpenAICompleteUploadFile = Binding.Service<OpenAICompleteUploadFile>(
  "Azure.CognitiveServices.OpenAICompleteUploadFile",
);
