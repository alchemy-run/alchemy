import type * as contentSafety from "@distilled.cloud/azure/cognitiveservices-content-safety";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DetectTextProtectedMaterialRequest extends Omit<
  contentSafety.TextOperationsDetectTextProtectedMaterialRequest,
  "endpoint"
> {}

/**
 * Detect known protected text (song lyrics, articles, recipes) in
 * AI-generated text with Azure AI Content Safety.
 *
 * Bind it to an Azure AI services account of kind `ContentSafety` or `AIServices`.
 * Binding assigns a custom role (`AzureCognitiveServicesContentSafetyDetectProtectedMaterialRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ContentSafety/text:detectprotectedmaterial/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every
 * Azure AI services data action and reading the account's keys.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link DetectTextProtectedMaterialHttp}.
 *
 * ### Calling DetectTextProtectedMaterial
 * **Example:** DetectTextProtectedMaterial from a Function
 * ```typescript
 * // init
 * const detect = yield* Azure.CognitiveServices.DetectTextProtectedMaterial(safety);
 *
 * // runtime
 * const { protectedMaterialAnalysis } = yield* detect({ text: completion });
 * // protectedMaterialAnalysis.detected → boolean
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DetectTextProtectedMaterial extends Binding.Service<
  DetectTextProtectedMaterial,
  "Azure.CognitiveServices.DetectTextProtectedMaterial",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DetectTextProtectedMaterialRequest,
    ) => Effect.Effect<
      contentSafety.DetectTextProtectedMaterialResult,
      contentSafety.TextOperationsDetectTextProtectedMaterialError,
      RuntimeContext
    >
  >
> {}

export const DetectTextProtectedMaterial = Binding.Service<DetectTextProtectedMaterial>(
  "Azure.CognitiveServices.DetectTextProtectedMaterial",
);
