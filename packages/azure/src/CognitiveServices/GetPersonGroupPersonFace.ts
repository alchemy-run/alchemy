import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetPersonGroupPersonFaceRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Retrieve person face information. The persisted person face is specified
 * by its personGroupId, personId and persistedFaceId.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupFacesReadRole`, one per
 * stack) with exactly the data action
 * `Face/persongroups/persons/persistedfaces/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetPersonGroupPersonFaceHttp}.
 *
 * ### Calling GetPersonGroupPersonFace
 * **Example:** GetPersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const getPersonGroupPersonFace = yield* Azure.CognitiveServices.GetPersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* getPersonGroupPersonFace({ personGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetPersonGroupPersonFace extends Binding.Service<
  GetPersonGroupPersonFace,
  "Azure.CognitiveServices.GetPersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetPersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.PersonGroupPersonFace,
      face.GetPersonGroupOperationPersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const GetPersonGroupPersonFace = Binding.Service<GetPersonGroupPersonFace>(
  "Azure.CognitiveServices.GetPersonGroupPersonFace",
);
