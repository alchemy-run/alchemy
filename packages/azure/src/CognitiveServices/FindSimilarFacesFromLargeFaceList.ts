import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface FindSimilarFacesFromLargeFaceListRequest extends Omit<
  face.ListFaceRecognitionOperationsFindSimilarFromLargeFaceRequest,
  "endpoint"
> {}

/**
 * Given query face's faceId, to search the similar-looking faces from a
 * Large Face List. A 'largeFaceListId' is created by Create Large Face List.
 * Depending on the input the returned similar faces list contains faceIds or
 * persistedFaceIds ranked by similarity.
 *
 * Binding assigns a custom role (`AzureAIFaceFindSimilarRole`, one per
 * stack) with exactly the data action `Face/findsimilars/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link FindSimilarFacesFromLargeFaceListHttp}.
 *
 * ### Calling FindSimilarFacesFromLargeFaceList
 * **Example:** FindSimilarFacesFromLargeFaceList from a Function
 * ```typescript
 * // init
 * const findSimilarFacesFromLargeFaceList = yield* Azure.CognitiveServices.FindSimilarFacesFromLargeFaceList(account);
 *
 * // runtime
 * const result = yield* findSimilarFacesFromLargeFaceList({ faceId, largeFaceListId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface FindSimilarFacesFromLargeFaceList extends Binding.Service<
  FindSimilarFacesFromLargeFaceList,
  "Azure.CognitiveServices.FindSimilarFacesFromLargeFaceList",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: FindSimilarFacesFromLargeFaceListRequest,
    ) => Effect.Effect<
      face.ListFaceRecognitionOperationsFindSimilarFromLargeFaceResponse,
      face.ListFaceRecognitionOperationsFindSimilarFromLargeFaceError,
      RuntimeContext
    >
  >
> {}

export const FindSimilarFacesFromLargeFaceList = Binding.Service<FindSimilarFacesFromLargeFaceList>(
  "Azure.CognitiveServices.FindSimilarFacesFromLargeFaceList",
);
