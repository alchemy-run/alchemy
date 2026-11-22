import type * as cu from "@distilled.cloud/azure/ai-content-understanding";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetContentAnalyzerResultFileRequest extends Omit<
  cu.GetContentAnalyzerResultFileRequest,
  "endpoint"
> {}

/**
 * Get a file associated with the result of an analysis operation.
 *
 * Binding assigns a custom role (`AzureAIContentResultFilesReadRole`, one
 * per stack) with exactly the data action
 * `MultiModalIntelligence/analyzerresults/files/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetContentAnalyzerResultFileHttp}.
 *
 * ### Calling GetContentAnalyzerResultFile
 * **Example:** GetContentAnalyzerResultFile from a Function
 * ```typescript
 * // init
 * const getContentAnalyzerResultFile = yield* Azure.CognitiveServices.GetContentAnalyzerResultFile(account);
 *
 * // runtime
 * const result = yield* getContentAnalyzerResultFile({ operationId, path });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetContentAnalyzerResultFile extends Binding.Service<
  GetContentAnalyzerResultFile,
  "Azure.CognitiveServices.GetContentAnalyzerResultFile",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetContentAnalyzerResultFileRequest,
    ) => Effect.Effect<
      cu.GetContentAnalyzerResultFileResponse,
      cu.GetContentAnalyzerResultFileError,
      RuntimeContext
    >
  >
> {}

export const GetContentAnalyzerResultFile = Binding.Service<GetContentAnalyzerResultFile>(
  "Azure.CognitiveServices.GetContentAnalyzerResultFile",
);
