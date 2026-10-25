import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface IdentifyFacesFromPersonGroupRequest extends Omit<
  face.FaceRecognitionOperationsIdentifyFromPersonGroupRequest,
  "endpoint"
> {}

/**
 * 1-to-many identification to find the closest matches of the specific query
 * person face from a Person Group.
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
 * {@link IdentifyFacesFromPersonGroupHttp}.
 *
 * ### Calling IdentifyFacesFromPersonGroup
 * **Example:** IdentifyFacesFromPersonGroup from a Function
 * ```typescript
 * // init
 * const identifyFacesFromPersonGroup = yield* Azure.CognitiveServices.IdentifyFacesFromPersonGroup(account);
 *
 * // runtime
 * const result = yield* identifyFacesFromPersonGroup({ faceIds, personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface IdentifyFacesFromPersonGroup extends Binding.Service<
  IdentifyFacesFromPersonGroup,
  "Azure.CognitiveServices.IdentifyFacesFromPersonGroup",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: IdentifyFacesFromPersonGroupRequest,
    ) => Effect.Effect<
      face.FaceRecognitionOperationsIdentifyFromPersonGroupResponse,
      face.FaceRecognitionOperationsIdentifyFromPersonGroupError,
      RuntimeContext
    >
  >
> {}

export const IdentifyFacesFromPersonGroup = Binding.Service<IdentifyFacesFromPersonGroup>(
  "Azure.CognitiveServices.IdentifyFacesFromPersonGroup",
);
