import type * as face from "@distilled.cloud/azure/ai-face";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Account } from "./Account.ts";

export interface GetPersonGroupPersonRequest extends Omit<
  face.GetPersonGroupOperationPersonGroupPersonRequest,
  "endpoint"
> {}

/**
 * Retrieve a person's name and userData, and the persisted faceIds
 * representing the registered person face feature(s).
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
 * {@link GetPersonGroupPersonHttp}.
 *
 * ### Calling GetPersonGroupPerson
 * **Example:** GetPersonGroupPerson from a Function
 * ```typescript
 * // init
 * const getPersonGroupPerson = yield* Azure.CognitiveServices.GetPersonGroupPerson(account);
 *
 * // runtime
 * const result = yield* getPersonGroupPerson({ personGroupId, personId });
 * ```
 *
 * @binding
 * @category CognitiveServices
 */
export interface GetPersonGroupPerson extends Binding.Service<
  GetPersonGroupPerson,
  "Azure.CognitiveServices.GetPersonGroupPerson",
  (
    account: Account,
  ) => Effect.Effect<
    (
      request: GetPersonGroupPersonRequest,
    ) => Effect.Effect<
      face.PersonGroupPerson,
      face.GetPersonGroupOperationPersonGroupPersonError,
      RuntimeContext
    >
  >
> {}

export const GetPersonGroupPerson = Binding.Service<GetPersonGroupPerson>(
  "Azure.CognitiveServices.GetPersonGroupPerson",
);
