import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeletePersonGroupPersonRequest extends Omit<
  face.DeletePersonGroupOperationPersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Delete an existing person from a Person Group. The persistedFaceId,
 * userData, person name and face feature(s) in the person entry will all be
 * deleted.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupPersonsDeleteRole`, one
 * per stack) with exactly the data action `Face/persongroups/persons/delete`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeletePersonGroupPersonHttp}.
 *
 * ### Calling DeletePersonGroupPerson
 * **Example:** DeletePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const deletePersonGroupPerson = yield* Azure.CognitiveServices.DeletePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* deletePersonGroupPerson({ personGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeletePersonGroupPerson extends Binding.Service<
  DeletePersonGroupPerson,
  "Azure.CognitiveServices.DeletePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeletePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationPersonGroupPersonResponse,
      face.DeletePersonGroupOperationPersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const DeletePersonGroupPerson = Binding.Service<DeletePersonGroupPerson>(
  "Azure.CognitiveServices.DeletePersonGroupPerson",
);
