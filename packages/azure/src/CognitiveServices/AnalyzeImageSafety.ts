import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface AnalyzeImageSafetyRequest extends Omit<
  contentSafety.ImageOperationsAnalyzeImageRequest,
  "endpoint"
> {}

/**
 * Score an image (base64 `content` or a `blobUrl`) for harmful content
 * (hate, self-harm, sexual, violence) with Azure AI Content Safety.
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyAnalyzeImageRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/image:analyze/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link AnalyzeImageSafetyHttp}.
 *
 * ### Calling AnalyzeImageSafety
 * **Example:** AnalyzeImageSafety from a Function
 * ```typescript
 * // init
 * const analyzeImageSafety = yield* Azure.CognitiveServices.AnalyzeImageSafety(safety);
 *
 * // runtime
 * const { categoriesAnalysis } = yield* analyzeImageSafety({
 *   image: { content: Buffer.from(bytes).toString("base64") },
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface AnalyzeImageSafety extends Binding.Service<
  AnalyzeImageSafety,
  "Azure.CognitiveServices.AnalyzeImageSafety",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: AnalyzeImageSafetyRequest,
    ) => Effect.Effect<
      contentSafety.AnalyzeImageResult,
      contentSafety.ImageOperationsAnalyzeImageError,
      RuntimeContext
    >
  >
> {}

export const AnalyzeImageSafety = Binding.Service<AnalyzeImageSafety>(
  "Azure.CognitiveServices.AnalyzeImageSafety",
);
