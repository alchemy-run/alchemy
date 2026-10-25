import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListLargePersonGroupPersonsRequest extends Omit<
  face.GetPersonGroupOperationLargePersonGroupPersonsRequest,
  "endpoint"
> {}

/**
 * List all persons' information in the specified Large Person Group,
 * including personId, name, userData and persistedFaceIds of registered
 * person faces. Persons are stored in alphabetical order of personId created
 * in "Create Large Person Group Person".
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
 * {@link ListLargePersonGroupPersonsHttp}.
 *
 * ### Calling ListLargePersonGroupPersons
 * **Example:** ListLargePersonGroupPersons from a Function
 * ```typescript
 * // init
 * const listLargePersonGroupPersons = yield* Azure.CognitiveServices.ListLargePersonGroupPersons(account);
 *
 * // runtime
 * const result = yield* listLargePersonGroupPersons({ largePersonGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListLargePersonGroupPersons extends Binding.Service<
  ListLargePersonGroupPersons,
  "Azure.CognitiveServices.ListLargePersonGroupPersons",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListLargePersonGroupPersonsRequest,
    ) => Effect.Effect<
      face.GetPersonGroupOperationLargePersonGroupPersonsResponse,
      face.GetPersonGroupOperationLargePersonGroupPersonsError,
      RuntimeContext
    >
  >
> {}

export const ListLargePersonGroupPersons = Binding.Service<ListLargePersonGroupPersons>(
  "Azure.CognitiveServices.ListLargePersonGroupPersons",
);
