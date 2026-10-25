import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface ListPersonGroupPersonsRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupPersonsRequest,
  "endpoint"
> {}

/**
 * List all persons' information in the specified Person Group, including
 * personId, name, userData and persistedFaceIds of registered person faces.
 * Persons are stored in alphabetical order of personId created in "Create
 * Person Group Person".
 *
 * Binding assigns a custom role (`AzureAIPersonGroupPersonsReadRole`, one
 * per stack) with exactly the data action `Face/persongroups/persons/read`
 * (under `Microsoft.CognitiveServices/accounts/`), on the account only. The
 * account needs a custom subdomain (Alchemy sets one by default). The
 * built-in **Azure AI User** and **Cognitive Services User** roles grant
 * every `Microsoft.CognitiveServices/*` data action. On a host with a
 * managed identity (an Azure Function, Function App, Web App, Container App,
 * container group, VM, or AKS workload identity) the role goes to that
 * identity; any other host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal (see `AzureBindings`). Provide
 * {@link ListPersonGroupPersonsHttp}.
 *
 * ### Calling ListPersonGroupPersons
 * **Example:** ListPersonGroupPersons from a Function
 * ```typescript
 * // init
 * const listPersonGroupPersons = yield* Azure.CognitiveServices.ListPersonGroupPersons(account);
 *
 * // runtime
 * const result = yield* listPersonGroupPersons({ personGroupId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface ListPersonGroupPersons extends Binding.Service<
  ListPersonGroupPersons,
  "Azure.CognitiveServices.ListPersonGroupPersons",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: ListPersonGroupPersonsRequest,
    ) => Effect.Effect<
      face.GetPersonGroupOperationPersonGroupPersonsResponse,
      face.GetPersonGroupOperationPersonGroupPersonsError,
      RuntimeContext
    >
  >
> {}

export const ListPersonGroupPersons = Binding.Service<ListPersonGroupPersons>(
  "Azure.CognitiveServices.ListPersonGroupPersons",
);
