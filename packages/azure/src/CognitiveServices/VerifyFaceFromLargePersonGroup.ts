import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface VerifyFaceFromLargePersonGroupRequest extends Omit<
  face.VerifyFaceRecognitionOperationFromLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * Verify whether a face belongs to a person in a Large Person Group. > *
 * Higher face image quality means better identification precision. Please
 * consider high-quality faces: frontal, clear, and face size is 200x200
 * pixels (100 pixels between eyes) or bigger.
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
 * {@link VerifyFaceFromLargePersonGroupHttp}.
 *
 * ### Calling VerifyFaceFromLargePersonGroup
 * **Example:** VerifyFaceFromLargePersonGroup from a Function
 * ```typescript
 * // init
 * const verifyFaceFromLargePersonGroup = yield* Azure.CognitiveServices.VerifyFaceFromLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* verifyFaceFromLargePersonGroup({ faceId, largePersonGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface VerifyFaceFromLargePersonGroup extends Binding.Service<
  VerifyFaceFromLargePersonGroup,
  "Azure.CognitiveServices.VerifyFaceFromLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: VerifyFaceFromLargePersonGroupRequest,
    ) => Effect.Effect<
      face.VerificationResult,
      face.VerifyFaceRecognitionOperationFromLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const VerifyFaceFromLargePersonGroup = Binding.Service<VerifyFaceFromLargePersonGroup>(
  "Azure.CognitiveServices.VerifyFaceFromLargePersonGroup",
);
