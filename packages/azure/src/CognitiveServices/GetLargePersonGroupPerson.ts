import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetLargePersonGroupPersonRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Retrieve a person's name and userData, and the persisted faceIds
 * representing the registered person face feature(s).
 *
 * Binding assigns a custom role (`AzureAILargePersonGroupPersonsReadRole`,
 * one per stack) with exactly the data action
 * `Face/largepersongroups/persons/read` (under
 * `Microsoft.CognitiveServices/accounts/`), on the account only. The account
 * needs a custom subdomain (Alchemy sets one by default). The built-in
 * **Azure AI User** and **Cognitive Services User** roles grant every
 * `Microsoft.CognitiveServices/*` data action. On a host with a managed
 * identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link GetLargePersonGroupPersonHttp}.
 *
 * ### Calling GetLargePersonGroupPerson
 * **Example:** GetLargePersonGroupPerson from a Function
 * ```typescript
 * // init
 * const getLargePersonGroupPerson = yield* Azure.CognitiveServices.GetLargePersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* getLargePersonGroupPerson({ largePersonGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetLargePersonGroupPerson extends Binding.Service<
  GetLargePersonGroupPerson,
  "Azure.CognitiveServices.GetLargePersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetLargePersonGroupPersonRequest,
    ) => Effect.Effect<
      face.LargePersonGroupPerson,
      face.GetPersonGroupOperationLargePersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const GetLargePersonGroupPerson = Binding.Service<GetLargePersonGroupPerson>(
  "Azure.CognitiveServices.GetLargePersonGroupPerson",
);
