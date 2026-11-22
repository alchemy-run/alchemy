import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SearchPhoneNumbersRequest extends Omit<
  phoneNumbers.SearchPhoneNumberAvailablePhoneNumbersRequest,
  "endpoint"
> {}

/**
 * Start a search for phone numbers to purchase. Read the result with
 * `GetPhoneNumberSearchResult`.
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
 * Provide {@link SearchPhoneNumbersHttp}.
 *
 * ### Calling SearchPhoneNumbers
 * **Example:** SearchPhoneNumbers from a Function
 * ```typescript
 * // init
 * const searchPhoneNumbers = yield* Azure.Communication.SearchPhoneNumbers(acs);
 *
 * // runtime
 * const search = yield* searchPhoneNumbers({
 *   countryCode: "US",
 *   phoneNumberType: "tollFree",
 *   assignmentType: "application",
 *   capabilities: { calling: "outbound", sms: "inbound+outbound" },
 *   quantity: 1,
 * });
 * // search.operationLocation
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SearchPhoneNumbers extends Binding.Service<
  SearchPhoneNumbers,
  "Azure.Communication.SearchPhoneNumbers",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SearchPhoneNumbersRequest,
    ) => Effect.Effect<
      phoneNumbers.SearchPhoneNumberAvailablePhoneNumbersResponse,
      phoneNumbers.SearchPhoneNumberAvailablePhoneNumbersError,
      RuntimeContext
    >
  >
> {}

export const SearchPhoneNumbers = Binding.Service<SearchPhoneNumbers>(
  "Azure.Communication.SearchPhoneNumbers",
);
