import type * as uv from "@distilled.cloud/azure/cognitiveservices-unified-vision";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface VectorizeTextRequest extends Omit<uv.VectorizeTextRequest, "endpoint"> {}

/**
 * Embed text into a vector with Azure AI Vision multimodal embeddings, in the same space as `VectorizeImage`, to search images by text.
 *
 * Bind it to an Azure AI services account of kind `ComputerVision` or `AIServices` (multimodal embeddings run in a subset of regions, e.g. `eastus`, `westus`, `westeurope`).
 * Binding assigns a custom role (`AzureCognitiveVectorizeTextRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ComputerVision/retrieval:vectorizetext/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link VectorizeTextHttp}.
 *
 * ### Calling VectorizeText
 * **Example:** VectorizeText from a Function
 * ```typescript
 * // init
 * const vectorizeText = yield* Azure.CognitiveServices.VectorizeText(vision);
 *
 * // runtime
 * const { vector } = yield* vectorizeText({ model_version: "2023-04-15", text: "a red bicycle" });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface VectorizeText extends Binding.Service<
  VectorizeText,
  "Azure.CognitiveServices.VectorizeText",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: VectorizeTextRequest,
    ) => Effect.Effect<uv.SingleVectorResult, uv.VectorizeTextError, RuntimeContext>
  >
> {}

export const VectorizeText = Binding.Service<VectorizeText>(
  "Azure.CognitiveServices.VectorizeText",
);
