import type * as vision from "@distilled.cloud/azure/ai-image-analysis";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeImageDataRequest extends Omit<
  vision.AnalyzeFromImageDataRequest,
  "endpoint"
> {}

/**
 * Performs a single Image Analysis operation.
 *
 * Binding assigns a custom role (`AzureAIImageAnalysisRole`, one per stack)
 * with exactly the data action `ComputerVision/imageanalysis:analyze/action`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link AnalyzeImageDataHttp}.
 *
 * ### Calling AnalyzeImageData
 * **Example:** AnalyzeImageData from a Function
 * ```typescript
 * // init
 * const analyzeImageData = yield* Azure.CognitiveServices.AnalyzeImageData(account);
 *
 * // runtime
 * const result = yield* analyzeImageData({ features, body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeImageData extends Binding.Service<
  AnalyzeImageData,
  "Azure.CognitiveServices.AnalyzeImageData",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeImageDataRequest,
    ) => Effect.Effect<vision.ImageAnalysisResult, vision.AnalyzeFromImageDataError, RuntimeContext>
  >
> {}

export const AnalyzeImageData = Binding.Service<AnalyzeImageData>(
  "Azure.CognitiveServices.AnalyzeImageData",
);
