import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface VerifyFaceFromPersonGroupRequest extends Omit<
  face.VerifyFaceRecognitionOperationFromPersonGroupRequest,
  "endpoint"
> {}

/**
 * Verify whether a face belongs to a person in a Person Group. > * Higher
 * face image quality means better identification precision. Please consider
 * high-quality faces: frontal, clear, and face size is 200x200 pixels (100
 * pixels between eyes) or bigger.
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
 * {@link VerifyFaceFromPersonGroupHttp}.
 *
 * ### Calling VerifyFaceFromPersonGroup
 * **Example:** VerifyFaceFromPersonGroup from a Function
 * ```typescript
 * // init
 * const verifyFaceFromPersonGroup = yield* Azure.CognitiveServices.VerifyFaceFromPersonGroup(account);
 *
 * // runtime
 * const result = yield* verifyFaceFromPersonGroup({ faceId, personGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface VerifyFaceFromPersonGroup extends Binding.Service<
  VerifyFaceFromPersonGroup,
  "Azure.CognitiveServices.VerifyFaceFromPersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: VerifyFaceFromPersonGroupRequest,
    ) => Effect.Effect<
      face.VerificationResult,
      face.VerifyFaceRecognitionOperationFromPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const VerifyFaceFromPersonGroup = Binding.Service<VerifyFaceFromPersonGroup>(
  "Azure.CognitiveServices.VerifyFaceFromPersonGroup",
);
