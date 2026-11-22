import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface DeleteLargePersonGroupPersonRequest extends Omit<
  face.DeletePersonGroupOperationLargePersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Delete an existing person from a Large Person Group. The persistedFaceId,
 * userData, person name and face feature(s) in the person entry will all be
 * deleted.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupPersonsDeleteRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/delete` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link DeleteLargePersonGroupPersonHttp}.
 *
 * ### Calling DeleteLargePersonGroupPerson
 * **Example:** DeleteLargePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const deleteLargePersonGroupPerson = yield* Azure.CognitiveServices.DeleteLargePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* deleteLargePersonGroupPerson({ largePersonGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface DeleteLargePersonGroupPerson extends Binding.Service<
  DeleteLargePersonGroupPerson,
  "Azure.CognitiveServices.DeleteLargePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: DeleteLargePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.DeletePersonGroupOperationLargePersonGroupPersonResponse,
      face.DeletePersonGroupOperationLargePersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const DeleteLargePersonGroupPerson = Binding.Service<DeleteLargePersonGroupPerson>(
  "Azure.CognitiveServices.DeleteLargePersonGroupPerson",
);
