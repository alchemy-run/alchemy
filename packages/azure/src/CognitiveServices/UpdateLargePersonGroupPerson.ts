import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdateLargePersonGroupPersonRequest extends Omit<
  face.UpdatePersonGroupOperationLargePersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Update name or userData of a person.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupPersonsWriteRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/write` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdateLargePersonGroupPersonHttp}.
 *
 * ### Calling UpdateLargePersonGroupPerson
 * **Example:** UpdateLargePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const updateLargePersonGroupPerson = yield* Azure.CognitiveServices.UpdateLargePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* updateLargePersonGroupPerson({ largePersonGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdateLargePersonGroupPerson extends Binding.Service<
  UpdateLargePersonGroupPerson,
  "Azure.CognitiveServices.UpdateLargePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdateLargePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationLargePersonGroupPersonResponse,
      face.UpdatePersonGroupOperationLargePersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const UpdateLargePersonGroupPerson = Binding.Service<UpdateLargePersonGroupPerson>(
  "Azure.CognitiveServices.UpdateLargePersonGroupPerson",
);
