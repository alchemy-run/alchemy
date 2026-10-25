import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumberOfferingsRequest extends Omit<
  phoneNumbers.ListPhoneNumberOfferingsRequest,
  "endpoint"
> {}

/**
 * List the phone number offerings (capabilities and rates) of a country.
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
 * Provide {@link ListPhoneNumberOfferingsHttp}.
 *
 * ### Calling ListPhoneNumberOfferings
 * **Example:** ListPhoneNumberOfferings from a Function
 * ```typescript
 * // init
 * const listPhoneNumberOfferings = yield* Azure.Communication.ListPhoneNumberOfferings(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumberOfferings({ countryCode: "US" });
 * // page.phoneNumberOfferings
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumberOfferings extends Binding.Service<
  ListPhoneNumberOfferings,
  "Azure.Communication.ListPhoneNumberOfferings",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListPhoneNumberOfferingsRequest,
    ) => Effect.Effect<
      phoneNumbers.OfferingsResponse,
      phoneNumbers.ListPhoneNumberOfferingsError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumberOfferings = Binding.Service<ListPhoneNumberOfferings>(
  "Azure.Communication.ListPhoneNumberOfferings",
);
