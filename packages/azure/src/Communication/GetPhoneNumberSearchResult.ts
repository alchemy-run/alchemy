import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetPhoneNumberSearchResultRequest extends Omit<
  phoneNumbers.PhoneNumbersGetSearchResultRequest,
  "endpoint"
> {}

/**
 * Read the result of a phone number search.
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetPhoneNumberSearchResultHttp}.
 *
 * ### Calling GetPhoneNumberSearchResult
 * **Example:** GetPhoneNumberSearchResult from a Function
 * ```typescript
 * // init
 * const getPhoneNumberSearchResult = yield* Azure.Communication.GetPhoneNumberSearchResult(acs);
 *
 * // runtime
 * const result = yield* getPhoneNumberSearchResult({ searchId });
 * // result.phoneNumbers, result.cost
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetPhoneNumberSearchResult extends Binding.Service<
  GetPhoneNumberSearchResult,
  "Azure.Communication.GetPhoneNumberSearchResult",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetPhoneNumberSearchResultRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumberSearchResult,
      phoneNumbers.PhoneNumbersGetSearchResultError,
      RuntimeContext
    >
  >
> {}

export const GetPhoneNumberSearchResult = Binding.Service<GetPhoneNumberSearchResult>(
  "Azure.Communication.GetPhoneNumberSearchResult",
);
