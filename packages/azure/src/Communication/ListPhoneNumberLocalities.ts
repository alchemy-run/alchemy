import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumberLocalitiesRequest extends Omit<
  phoneNumbers.ListPhoneNumberAvailableLocalitiesRequest,
  "endpoint"
> {}

/**
 * List the cities or towns with available geographic numbers in a country.
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
 * Provide {@link ListPhoneNumberLocalitiesHttp}.
 *
 * ### Calling ListPhoneNumberLocalities
 * **Example:** ListPhoneNumberLocalities from a Function
 * ```typescript
 * // init
 * const listPhoneNumberLocalities = yield* Azure.Communication.ListPhoneNumberLocalities(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumberLocalities({ countryCode: "US" });
 * // page.phoneNumberLocalities
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumberLocalities extends Binding.Service<
  ListPhoneNumberLocalities,
  "Azure.Communication.ListPhoneNumberLocalities",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: ListPhoneNumberLocalitiesRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumberLocalities,
      phoneNumbers.ListPhoneNumberAvailableLocalitiesError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumberLocalities = Binding.Service<ListPhoneNumberLocalities>(
  "Azure.Communication.ListPhoneNumberLocalities",
);
