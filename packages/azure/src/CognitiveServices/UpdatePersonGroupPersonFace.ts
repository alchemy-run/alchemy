import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdatePersonGroupPersonFaceRequest extends Omit<
  face.UpdatePersonGroupOperationPersonGroupPersonFaceRequest,
  "endpoint"
> {}

/**
 * Update a person persisted face's userData field.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupFacesWriteRole`, one per
 * stack) with exactly the data action
 * `Face/persongroups/persons/persistedfaces/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdatePersonGroupPersonFaceHttp}.
 *
 * ### Calling UpdatePersonGroupPersonFace
 * **Example:** UpdatePersonGroupPersonFace from a Function
 * ```typescript
 * // init
 * const updatePersonGroupPersonFace = yield* Azure.CognitiveServices.UpdatePersonGroupPersonFace(account);
 *
 * // runtime
 * const result = yield* updatePersonGroupPersonFace({ personGroupId, personId, persistedFaceId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdatePersonGroupPersonFace extends Binding.Service<
  UpdatePersonGroupPersonFace,
  "Azure.CognitiveServices.UpdatePersonGroupPersonFace",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdatePersonGroupPersonFaceRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationPersonGroupPersonFaceResponse,
      face.UpdatePersonGroupOperationPersonGroupPersonFaceError,
      RuntimeContext
    >
  >
> {}

export const UpdatePersonGroupPersonFace = Binding.Service<UpdatePersonGroupPersonFace>(
  "Azure.CognitiveServices.UpdatePersonGroupPersonFace",
);
