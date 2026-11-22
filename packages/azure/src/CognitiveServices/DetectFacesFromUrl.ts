import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DetectFacesFromUrlRequest extends Omit<
  face.FaceDetectionOperationsDetectFromUrlRequest,
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
 * {@link DetectFacesFromUrlHttp}.
 *
 * ### Calling DetectFacesFromUrl
 * **Example:** DetectFacesFromUrl from a Function
 * ```typescript
 * // init
 * const detectFacesFromUrl = yield* Azure.CognitiveServices.DetectFacesFromUrl(account);
 *
 * // runtime
 * const faces = yield* detectFacesFromUrl({
 *   url: "https://example.com/photo.jpg",
 *   detectionModel: "detection_03",
 *   returnFaceId: false,
 * });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DetectFacesFromUrl extends Binding.Service<
  DetectFacesFromUrl,
  "Azure.CognitiveServices.DetectFacesFromUrl",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DetectFacesFromUrlRequest,
    ) => Effect.Effect<
      face.FaceDetectionOperationsDetectFromUrlResponse,
      face.FaceDetectionOperationsDetectFromUrlError,
      RuntimeContext
    >
  >
> {}

export const DetectFacesFromUrl = Binding.Service<DetectFacesFromUrl>(
  "Azure.CognitiveServices.DetectFacesFromUrl",
);
