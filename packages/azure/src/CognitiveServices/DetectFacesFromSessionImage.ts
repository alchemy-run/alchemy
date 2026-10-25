import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DetectFacesFromSessionImageRequest extends Omit<
  face.FaceDetectionOperationsDetectFromSessionImageIdRequest,
  "endpoint"
> {}

/**
 * Detect human faces in an image, return face rectangles, and optionally
 * with faceIds, landmarks, and attributes.
 *
 * Binding assigns a custom role (`AzureAIFaceDetectRole`, one per stack)
 * with exactly the data action `Face/detect/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DetectFacesFromSessionImageHttp}.
 *
 * ### Calling DetectFacesFromSessionImage
 * **Example:** DetectFacesFromSessionImage from a Function
 * ```typescript
 * // init
 * const detectFacesFromSessionImage = yield* Azure.CognitiveServices.DetectFacesFromSessionImage(account);
 *
 * // runtime
 * const result = yield* detectFacesFromSessionImage({ sessionImageId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DetectFacesFromSessionImage extends Binding.Service<
  DetectFacesFromSessionImage,
  "Azure.CognitiveServices.DetectFacesFromSessionImage",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DetectFacesFromSessionImageRequest,
    ) => Effect.Effect<
      face.FaceDetectionOperationsDetectFromSessionImageIdResponse,
      face.FaceDetectionOperationsDetectFromSessionImageIdError,
      RuntimeContext
    >
  >
> {}

export const DetectFacesFromSessionImage = Binding.Service<DetectFacesFromSessionImage>(
  "Azure.CognitiveServices.DetectFacesFromSessionImage",
);
