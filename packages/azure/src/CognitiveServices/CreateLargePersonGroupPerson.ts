import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface CreateLargePersonGroupPersonRequest extends Omit<
  face.CreatePersonGroupOperationLargePersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Create a new person in a specified Large Person Group. To add face to this
 * person, please call "Add Large Person Group Person Face". > * Free-tier
 * subscription quota: 1,000 persons in all Large Person Groups. S0-tier
 * subscription quota: 1,000,000 persons per Large Person Group. 1,000,000
 * Large Person Groups.
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupPersonsCreateRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/action` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link CreateLargePersonGroupPersonHttp}.
 *
 * ### Calling CreateLargePersonGroupPerson
 * **Example:** CreateLargePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const createLargePersonGroupPerson = yield* Azure.CognitiveServices.CreateLargePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* createLargePersonGroupPerson({ largePersonGroupId, name });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface CreateLargePersonGroupPerson extends Binding.Service<
  CreateLargePersonGroupPerson,
  "Azure.CognitiveServices.CreateLargePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: CreateLargePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.CreatePersonResult,
      face.CreatePersonGroupOperationLargePersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const CreateLargePersonGroupPerson = Binding.Service<CreateLargePersonGroupPerson>(
  "Azure.CognitiveServices.CreateLargePersonGroupPerson",
);
