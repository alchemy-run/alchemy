import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface ListPhoneNumberReservationsRequest extends Omit<
  phoneNumbers.ListPhoneNumberReservationsRequest,
  "endpoint"
> {}

/**
 * List phone number reservations, one page per call (pass the previous
 * page's `nextLink` for the next).
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
 * Provide {@link ListPhoneNumberReservationsHttp}.
 *
 * ### Calling ListPhoneNumberReservations
 * **Example:** ListPhoneNumberReservations from a Function
 * ```typescript
 * // init
 * const listPhoneNumberReservations = yield* Azure.Communication.ListPhoneNumberReservations(acs);
 *
 * // runtime
 * const page = yield* listPhoneNumberReservations();
 * // page.value, page.nextLink
 * ```
 *
 * @binding
 * @category Communication
 */
export interface ListPhoneNumberReservations extends Binding.Service<
  ListPhoneNumberReservations,
  "Azure.Communication.ListPhoneNumberReservations",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request?: ListPhoneNumberReservationsRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersReservations,
      phoneNumbers.ListPhoneNumberReservationsError,
      RuntimeContext
    >
  >
> {}

export const ListPhoneNumberReservations = Binding.Service<ListPhoneNumberReservations>(
  "Azure.Communication.ListPhoneNumberReservations",
);
