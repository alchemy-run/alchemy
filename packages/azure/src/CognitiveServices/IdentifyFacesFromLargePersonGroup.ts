import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface IdentifyFacesFromLargePersonGroupRequest extends Omit<
  face.FaceRecognitionOperationsIdentifyFromLargePersonGroupRequest,
  "endpoint"
> {}

/**
 * 1-to-many identification to find the closest matches of the specific query
 * person face from a Large Person Group.
 *
 * Binding assigns a custom role (`AzureAIFaceIdentifyRole`, one per stack)
 * with exactly the data action `Face/identify/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link IdentifyFacesFromLargePersonGroupHttp}.
 *
 * ### Calling IdentifyFacesFromLargePersonGroup
 * **Example:** IdentifyFacesFromLargePersonGroup from a Function
 * ```typescript
 * // init
 * const identifyFacesFromLargePersonGroup = yield* Azure.CognitiveServices.IdentifyFacesFromLargePersonGroup(account);
 *
 * // runtime
 * const result = yield* identifyFacesFromLargePersonGroup({ faceIds, largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface IdentifyFacesFromLargePersonGroup extends Binding.Service<
  IdentifyFacesFromLargePersonGroup,
  "Azure.CognitiveServices.IdentifyFacesFromLargePersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: IdentifyFacesFromLargePersonGroupRequest,
    ) => Effect.Effect<
      face.FaceRecognitionOperationsIdentifyFromLargePersonGroupResponse,
      face.FaceRecognitionOperationsIdentifyFromLargePersonGroupError,
      RuntimeContext
    >
  >
> {}

export const IdentifyFacesFromLargePersonGroup = Binding.Service<IdentifyFacesFromLargePersonGroup>(
  "Azure.CognitiveServices.IdentifyFacesFromLargePersonGroup",
);
