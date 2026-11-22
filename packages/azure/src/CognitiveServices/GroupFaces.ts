import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GroupFacesRequest extends Omit<
  face.FaceRecognitionOperationsGroupRequest,
  "endpoint"
> {}

/**
 * Divide candidate faces into groups based on face similarity. * The output
 * is one or more disjointed face groups and a messyGroup. A face group
 * contains faces that have similar looking, often of the same person. e.
 * number of faces.
 *
 * Binding assigns a custom role (`AzureAIFaceGroupRole`, one per stack) with
 * exactly the data action `Face/group/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GroupFacesHttp}.
 *
 * ### Calling GroupFaces
 * **Example:** GroupFaces from a Function
 * ```typescript
 * // init
 * const groupFaces = yield* Azure.CognitiveServices.GroupFaces(account);
 *
 * // runtime
 * const result = yield* groupFaces({ faceIds });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GroupFaces extends Binding.Service<
  GroupFaces,
  "Azure.CognitiveServices.GroupFaces",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GroupFacesRequest,
    ) => Effect.Effect<
      face.GroupingResult,
      face.FaceRecognitionOperationsGroupError,
      RuntimeContext
    >
  >
> {}

export const GroupFaces = Binding.Service<GroupFaces>("Azure.CognitiveServices.GroupFaces");
