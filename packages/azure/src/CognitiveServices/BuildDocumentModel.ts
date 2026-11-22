import type * as documents from "@distilled.cloud/azure/ai-document-intelligence";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface BuildDocumentModelRequest extends Omit<
  documents.DocumentModelsBuildModelRequest,
  "endpoint"
> {}

/**
 * Builds a custom document analysis model.
 *
 * Binding assigns a custom role (`AzureAIDocumentModelsBuildRole`, one per
 * stack) with exactly the data actions
 * `FormRecognizer/documentmodels:build/action` and
 * `FormRecognizer/documentmodels:build/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link BuildDocumentModelHttp}.
 *
 * ### Calling BuildDocumentModel
 * **Example:** BuildDocumentModel from a Function
 * ```typescript
 * // init
 * const buildDocumentModel = yield* Azure.CognitiveServices.BuildDocumentModel(account);
 *
 * // runtime
 * const result = yield* buildDocumentModel({ modelId, buildMode });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface BuildDocumentModel extends Binding.Service<
  BuildDocumentModel,
  "Azure.CognitiveServices.BuildDocumentModel",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: BuildDocumentModelRequest,
    ) => Effect.Effect<
      documents.DocumentModelsBuildModelResponse,
      documents.DocumentModelsBuildModelError,
      RuntimeContext
    >
  >
> {}

export const BuildDocumentModel = Binding.Service<BuildDocumentModel>(
  "Azure.CognitiveServices.BuildDocumentModel",
);
