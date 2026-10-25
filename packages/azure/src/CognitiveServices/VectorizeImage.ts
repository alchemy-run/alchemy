import type * as uv from "@distilled.cloud/azure/cognitiveservices-unified-vision";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface VectorizeImageRequest extends Omit<uv.VectorizeImageRequest, "endpoint"> {}

/**
 * Embed an image at a public URL into a vector with Azure AI Vision multimodal embeddings; `VectorizeText` embeds text into the same space for image search.
 *
 * Bind it to an Azure AI services account of kind `ComputerVision` or `AIServices` (multimodal embeddings run in a subset of regions, e.g. `eastus`, `westus`, `westeurope`).
 * Binding assigns a custom role (`AzureCognitiveVectorizeImageRole`, one per stack)
 * with exactly the data action
 * `Microsoft.CognitiveServices/accounts/ComputerVision/retrieval:vectorizeimage/action`, on the account only.
 * The smallest built-in role, **Cognitive Services User**, grants every Azure AI services data action.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link VectorizeImageHttp}.
 *
 * ### Calling VectorizeImage
 * **Example:** VectorizeImage from a Function
 * ```typescript
 * // init
 * const vectorizeImage = yield* Azure.CognitiveServices.VectorizeImage(vision);
 *
 * // runtime
 * const { vector } = yield* vectorizeImage({
 *   model_version: "2023-04-15",
 *   url: "https://example.com/photo.jpg",
 * });
 * // vector.length === 1024
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface VectorizeImage extends Binding.Service<
  VectorizeImage,
  "Azure.CognitiveServices.VectorizeImage",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: VectorizeImageRequest,
    ) => Effect.Effect<uv.SingleVectorResult, uv.VectorizeImageError, RuntimeContext>
  >
> {}

export const VectorizeImage = Binding.Service<VectorizeImage>(
  "Azure.CognitiveServices.VectorizeImage",
);
