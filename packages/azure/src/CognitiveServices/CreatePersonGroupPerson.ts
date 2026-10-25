import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreatePersonGroupPersonRequest extends Omit<
  face.CreatePersonGroupOperationPersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Create a new person in a specified Person Group. To add face to this
 * person, please call "Add Person Group Person Face". > * Free-tier
 * subscription quota: 1,000 persons in all Person Groups. S0-tier
 * subscription quota: 10,000 persons per Person Group. 1,000,000 Person
 * Groups. 100,000,000 persons in all Person Groups.
 *
 * Binding assigns a custom role (`AzureAIPersonGroupPersonsCreateRole`, one
 * per stack) with exactly the data action `Face/persongroups/persons/action`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreatePersonGroupPersonHttp}.
 *
 * ### Calling CreatePersonGroupPerson
 * **Example:** CreatePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const createPersonGroupPerson = yield* Azure.CognitiveServices.CreatePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* createPersonGroupPerson({ personGroupId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreatePersonGroupPerson extends Binding.Service<
  CreatePersonGroupPerson,
  "Azure.CognitiveServices.CreatePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreatePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.CreatePersonResult,
      face.CreatePersonGroupOperationPersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const CreatePersonGroupPerson = Binding.Service<CreatePersonGroupPerson>(
  "Azure.CognitiveServices.CreatePersonGroupPerson",
);
