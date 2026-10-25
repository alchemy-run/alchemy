import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ClassifyDocumentRequest extends Omit<
  documents.DocumentClassifiersClassifyDocumentRequest,
  "endpoint"
> {}

/**
 * Classifies document with document classifier.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifyRole`, one per
 * stack) with exactly the data action
 * `FormRecognizer/documentclassifiers:analyze/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ClassifyDocumentHttp}.
 *
 * ### Calling ClassifyDocument
 * **Example:** ClassifyDocument from a Function
 * ```typescript
 * // init
 * const classifyDocument = yield* Azure.CognitiveServices.ClassifyDocument(account);
 *
 * // runtime
 * const result = yield* classifyDocument({ classifierId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ClassifyDocument extends Binding.Service<
  ClassifyDocument,
  "Azure.CognitiveServices.ClassifyDocument",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ClassifyDocumentRequest,
    ) => Effect.Effect<
      documents.DocumentClassifiersClassifyDocumentResponse,
      documents.DocumentClassifiersClassifyDocumentError,
      RuntimeContext
    >
  >
> {}

export const ClassifyDocument = Binding.Service<ClassifyDocument>(
  "Azure.CognitiveServices.ClassifyDocument",
);
