import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface VerifyFaceToFaceRequest extends Omit<
  face.VerifyFaceRecognitionOperationFaceToFaceRequest,
  "endpoint"
> {}

/**
 * Verify whether two faces belong to a same person. > * Higher face image
 * quality means better identification precision. Please consider
 * high-quality faces: frontal, clear, and face size is 200x200 pixels (100
 * pixels between eyes) or bigger. For the scenarios that are sensitive to
 * accuracy please make your own judgment.
 *
 * Binding assigns a custom role (`AzureAIFaceVerifyRole`, one per stack)
 * with exactly the data action `Face/verify/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link VerifyFaceToFaceHttp}.
 *
 * ### Calling VerifyFaceToFace
 * **Example:** VerifyFaceToFace from a Function
 * ```typescript
 * // init
 * const verifyFaceToFace = yield* Azure.CognitiveServices.VerifyFaceToFace(account);
 *
 * // runtime
 * const result = yield* verifyFaceToFace({ faceId1, faceId2 });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface VerifyFaceToFace extends Binding.Service<
  VerifyFaceToFace,
  "Azure.CognitiveServices.VerifyFaceToFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: VerifyFaceToFaceRequest,
    ) => Effect.Effect<
      face.VerificationResult,
      face.VerifyFaceRecognitionOperationFaceToFaceError,
      RuntimeContext
    >
  >
> {}

export const VerifyFaceToFace = Binding.Service<VerifyFaceToFace>(
  "Azure.CognitiveServices.VerifyFaceToFace",
);
