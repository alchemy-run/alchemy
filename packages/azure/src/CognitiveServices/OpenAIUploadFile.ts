import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIUploadFileRequest extends Omit<
  authoring.UploadFileRequest,
  "endpoint" | "file"
> {
  /** The file to send: a `File` (its name is sent as the filename) or a `Blob`. */
  file: Blob;
}

/**
 * Upload a file (training data or batch input) to an Azure OpenAI account.
 * Pass a `File` whose name ends in `.jsonl`.
 *
 * Binding assigns a custom role (`AzureOpenAIFileWriteRole`, one per stack)
 * with exactly the data action `OpenAI/files/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIUploadFileHttp}.
 *
 * ### Calling OpenAIUploadFile
 * **Example:** OpenAIUploadFile from a Function
 * ```typescript
 * // init
 * const uploadFile = yield* Azure.CognitiveServices.OpenAIUploadFile(account);
 *
 * // runtime
 * const file = yield* uploadFile({
 *   purpose: "batch",
 *   file: new File([lines], "requests.jsonl"),
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIUploadFile extends Binding.Service<
  OpenAIUploadFile,
  "Azure.CognitiveServices.OpenAIUploadFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIUploadFileRequest,
    ) => Effect.Effect<authoring.UploadFileResponse, authoring.UploadFileError, RuntimeContext>
  >
> {}

export const OpenAIUploadFile = Binding.Service<OpenAIUploadFile>(
  "Azure.CognitiveServices.OpenAIUploadFile",
);
