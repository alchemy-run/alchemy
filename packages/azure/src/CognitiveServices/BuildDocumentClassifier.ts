import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface BuildDocumentClassifierRequest extends Omit<
  documents.DocumentClassifiersBuildClassifierRequest,
  "endpoint"
> {}

/**
 * Builds a custom document classifier.
 *
 * Binding assigns a custom role (`AzureAIDocumentClassifiersBuildRole`, one
 * per stack) with exactly the data action
 * `FormRecognizer/documentclassifiers:build/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link BuildDocumentClassifierHttp}.
 *
 * ### Calling BuildDocumentClassifier
 * **Example:** BuildDocumentClassifier from a Function
 * ```typescript
 * // init
 * const buildDocumentClassifier = yield* Azure.CognitiveServices.BuildDocumentClassifier(account);
 *
 * // runtime
 * const result = yield* buildDocumentClassifier({ classifierId, docTypes });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface BuildDocumentClassifier extends Binding.Service<
  BuildDocumentClassifier,
  "Azure.CognitiveServices.BuildDocumentClassifier",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: BuildDocumentClassifierRequest,
    ) => Effect.Effect<
      documents.DocumentClassifiersBuildClassifierResponse,
      documents.DocumentClassifiersBuildClassifierError,
      RuntimeContext
    >
  >
> {}

export const BuildDocumentClassifier = Binding.Service<BuildDocumentClassifier>(
  "Azure.CognitiveServices.BuildDocumentClassifier",
);
