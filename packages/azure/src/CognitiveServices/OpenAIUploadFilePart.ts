import type * as authoring from "@distilled.cloud/azure/cognitiveservices-openai-authoring";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface OpenAIUploadFilePartRequest extends Omit<
  authoring.UploadFilePartRequest,
  "endpoint" | "data"
> {
  /** The bytes of this part. */
  data: Blob;
}

/**
 * Add one part (a `Blob`) to a multi-part upload of an Azure OpenAI account.
 *
 * Binding assigns a custom role (`AzureOpenAIUploadWriteRole`, one per stack, shared with `OpenAIStartUploadFile`, `OpenAICompleteUploadFile`, `OpenAICancelUploadFile`)
 * with exactly the data action `OpenAI/uploads/write`, on the account only.
 * The built-in **Cognitive Services OpenAI User** role also reads every
 * Azure OpenAI object and runs every deployment kind. The account needs a
 * custom subdomain (`Azure.CognitiveServices.Account` sets one by default):
 * Entra ID tokens only work on `{subdomain}.openai.azure.com`.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link OpenAIUploadFilePartHttp}.
 *
 * ### Calling OpenAIUploadFilePart
 * **Example:** OpenAIUploadFilePart from a Function
 * ```typescript
 * // init
 * const uploadPart = yield* Azure.CognitiveServices.OpenAIUploadFilePart(account);
 *
 * // runtime
 * const part = yield* uploadPart({ uploadId: upload.id!, data: new Blob([lines]) });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface OpenAIUploadFilePart extends Binding.Service<
  OpenAIUploadFilePart,
  "Azure.CognitiveServices.OpenAIUploadFilePart",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: OpenAIUploadFilePartRequest,
    ) => Effect.Effect<authoring.UploadPartResource, authoring.UploadFilePartError, RuntimeContext>
  >
> {}

export const OpenAIUploadFilePart = Binding.Service<OpenAIUploadFilePart>(
  "Azure.CognitiveServices.OpenAIUploadFilePart",
);
