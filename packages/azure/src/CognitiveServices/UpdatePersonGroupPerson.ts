import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface UpdatePersonGroupPersonRequest extends Omit<
  face.UpdatePersonGroupOperationPersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Update name or userData of a person.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupPersonsWriteRole`, one
 * per stack) with exactly the data action `Face/persongroups/persons/write`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link UpdatePersonGroupPersonHttp}.
 *
 * ### Calling UpdatePersonGroupPerson
 * **Example:** UpdatePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const updatePersonGroupPerson = yield* Azure.CognitiveServices.UpdatePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* updatePersonGroupPerson({ personGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface UpdatePersonGroupPerson extends Binding.Service<
  UpdatePersonGroupPerson,
  "Azure.CognitiveServices.UpdatePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: UpdatePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.UpdatePersonGroupOperationPersonGroupPersonResponse,
      face.UpdatePersonGroupOperationPersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const UpdatePersonGroupPerson = Binding.Service<UpdatePersonGroupPerson>(
  "Azure.CognitiveServices.UpdatePersonGroupPerson",
);
