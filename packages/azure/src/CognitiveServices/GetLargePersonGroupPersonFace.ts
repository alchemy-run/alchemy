import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargePersonGroupPersonFaceRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Retrieve person face information. The persisted person face is specified
 * by its largePersonGroupId, personId and persistedFaceId.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupFacesReadRole`, one
 * per stack) with exactly the data action
 * `Face/largepersongroups/persons/persistedfaces/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargePersonGroupPersonFaceHttp}.
 *
 * ### Calling GetLargePersonGroupPersonFace
 * **Example:** GetLargePersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const getLargePersonGroupPersonFace = yield* Azure.CognitiveServices.GetLargePersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* getLargePersonGroupPersonFace({ largePersonGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargePersonGroupPersonFace extends Binding.Service<
  GetLargePersonGroupPersonFace,
  "Azure.CognitiveServices.GetLargePersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargePersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.LargePersonGroupPersonFace,
      face.GetPersonGroupOperationLargePersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const GetLargePersonGroupPersonFace = Binding.Service<GetLargePersonGroupPersonFace>(
  "Azure.CognitiveServices.GetLargePersonGroupPersonFace",
);
