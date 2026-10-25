import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DetectFacesRequest extends Omit<
  face.FaceDetectionOperationsDetectRequest,
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
 * {@link DetectFacesHttp}.
 *
 * ### Calling DetectFaces
 * **Example:** DetectFaces from a Function
 * ```typescript
 * // init
 * const detectFaces = yield* Azure.CognitiveServices.DetectFaces(account);
 *
 * // runtime
 * const result = yield* detectFaces({ body });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DetectFaces extends Binding.Service<
  DetectFaces,
  "Azure.CognitiveServices.DetectFaces",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DetectFacesRequest,
    ) => Effect.Effect<
      face.FaceDetectionOperationsDetectResponse,
      face.FaceDetectionOperationsDetectError,
      RuntimeContext
    >
  >
> {}

export const DetectFaces = Binding.Service<DetectFaces>("Azure.CognitiveServices.DetectFaces");
