import type * as documents from "@distilled.cloud/azure/cognitiveservices-language-analyze-documents";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface SubmitAnalyzeDocumentsJobRequest extends Omit<
  documents.AnalyzeDocumentsSubmitJobRequest,
  "endpoint"
> {}

/**
 * Submit an Azure AI Language native-document job (PII redaction of
 * Word or PDF files in Blob Storage). The account's managed identity reads
 * the `source` blobs and writes the `target` container. The response's
 * `operationLocation` ends in the job ID; read the job with
 * {@link GetAnalyzeDocumentsJob}.
 *
 * Bind it to an Azure AI services account of kind `TextAnalytics` (Language) or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesLanguageSubmitAnalyzeDocumentsJobRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/Language/analyze-documents/jobs/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link SubmitAnalyzeDocumentsJobHttp}.
 *
 * ### Calling SubmitAnalyzeDocumentsJob
 * **Example:** SubmitAnalyzeDocumentsJob from a Function
 * ```typescript
 * // init
 * const submitJob = yield* Azure.CognitiveServices.SubmitAnalyzeDocumentsJob(language);
 *
 * // runtime
 * const { operationLocation } = yield* submitJob({
 *   analysisInput: {
 *     documents: [{
 *       id: "1",
 *       language: "en",
 *       source: { kind: "AzureBlob", location: "https://acct.blob.core.windows.net/in/a.docx" },
 *       target: { kind: "AzureBlob", location: "https://acct.blob.core.windows.net/out" },
 *     }],
 *   },
 *   tasks: [{ kind: "PiiEntityRecognition" }],
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface SubmitAnalyzeDocumentsJob extends Binding.Service<
  SubmitAnalyzeDocumentsJob,
  "Azure.CognitiveServices.SubmitAnalyzeDocumentsJob",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: SubmitAnalyzeDocumentsJobRequest,
    ) => Effect.Effect<
      documents.AnalyzeDocumentsSubmitJobResponse,
      documents.AnalyzeDocumentsSubmitJobError,
      RuntimeContext
    >
  >
> {}

export const SubmitAnalyzeDocumentsJob = Binding.Service<SubmitAnalyzeDocumentsJob>(
  "Azure.CognitiveServices.SubmitAnalyzeDocumentsJob",
);
