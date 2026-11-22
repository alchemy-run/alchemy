import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface FindSimilarFacesRequest extends Omit<
  face.FaceRecognitionOperationsFindSimilarRequest,
  "endpoint"
> {}

/**
 * Given query face's faceId, to search the similar-looking faces from a
 * faceId array. A faceId array contains the faces created by Detect.
 * Depending on the input the returned similar faces list contains faceIds or
 * persistedFaceIds ranked by similarity. Find similar has two working modes,
 * "matchPerson" and "matchFace".
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
 * {@link FindSimilarFacesHttp}.
 *
 * ### Calling FindSimilarFaces
 * **Example:** FindSimilarFaces from a Function
 * ```typescript
 * // init
 * const findSimilarFaces = yield* Azure.CognitiveServices.FindSimilarFaces(account);
 *
 * // runtime
 * const result = yield* findSimilarFaces({ faceId, faceIds });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface FindSimilarFaces extends Binding.Service<
  FindSimilarFaces,
  "Azure.CognitiveServices.FindSimilarFaces",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: FindSimilarFacesRequest,
    ) => Effect.Effect<
      face.FaceRecognitionOperationsFindSimilarResponse,
      face.FaceRecognitionOperationsFindSimilarError,
      RuntimeContext
    >
  >
> {}

export const FindSimilarFaces = Binding.Service<FindSimilarFaces>(
  "Azure.CognitiveServices.FindSimilarFaces",
);
