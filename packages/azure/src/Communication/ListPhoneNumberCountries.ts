import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumberCountriesRequest extends Omit<
  phoneNumbers.ListPhoneNumberAvailableCountriesRequest,
  "endpoint"
> {}

/**
 * List the countries where phone numbers are available, one page per call
 * (pass the previous page's `nextLink` for the next).
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
 * Provide {@link ListPhoneNumberCountriesHttp}.
 *
 * ### Calling ListPhoneNumberCountries
 * **Example:** ListPhoneNumberCountries from a Function
 * ```typescript
 * // init
 * const listPhoneNumberCountries = yield* Azure.Communication.ListPhoneNumberCountries(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumberCountries();
 * // page.countries
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumberCountries extends Binding.Service<
  ListPhoneNumberCountries,
  "Azure.Communication.ListPhoneNumberCountries",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListPhoneNumberCountriesRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumberCountries,
      phoneNumbers.ListPhoneNumberAvailableCountriesError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumberCountries = Binding.Service<ListPhoneNumberCountries>(
  "Azure.Communication.ListPhoneNumberCountries",
);
