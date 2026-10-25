import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIStartUploadFileRequest extends Omit<
  authoring.StartUploadFileRequest,
  "endpoint"
> {}

/**
 * Start a multi-part upload (up to 9 GB, expires after two hours) to an
 * Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIUploadWriteRole`, one per stack, shared with `OpenAIUploadFilePart`, `OpenAICompleteUploadFile`, `OpenAICancelUploadFile`)
 * with exactly the data action `OpenAI/uploads/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIStartUploadFileHttp}.
 *
 * ### Calling OpenAIStartUploadFile
 * **Example:** OpenAIStartUploadFile from a Function
 * ```typescript
 * // init
 * const startUpload = yield* Azure.CognitiveServices.OpenAIStartUploadFile(account);
 *
 * // runtime
 * const upload = yield* startUpload({
 *   purpose: "batch",
 *   filename: "requests.jsonl",
 *   bytes: lines.byteLength,
 *   mime_type: "application/jsonl",
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIStartUploadFile extends Binding.Service<
  OpenAIStartUploadFile,
  "Azure.CognitiveServices.OpenAIStartUploadFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIStartUploadFileRequest,
    ) => Effect.Effect<
      authoring.StartUploadFileResponse,
      authoring.StartUploadFileError,
      RuntimeContext
    >
  >
> {}

export const OpenAIStartUploadFile = Binding.Service<OpenAIStartUploadFile>(
  "Azure.CognitiveServices.OpenAIStartUploadFile",
);
