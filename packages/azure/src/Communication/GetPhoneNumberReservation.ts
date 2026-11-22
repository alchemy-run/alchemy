import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetPhoneNumberReservationRequest extends Omit<
  phoneNumbers.GetPhoneNumberReservationRequest,
  "endpoint"
> {}

/**
 * Read a phone number reservation and its numbers.
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
 * Provide {@link GetPhoneNumberReservationHttp}.
 *
 * ### Calling GetPhoneNumberReservation
 * **Example:** GetPhoneNumberReservation from a Function
 * ```typescript
 * // init
 * const getPhoneNumberReservation = yield* Azure.Communication.GetPhoneNumberReservation(acs);
 *
 * // runtime
 * const reservation = yield* getPhoneNumberReservation({ reservationId });
 * // reservation.status, reservation.phoneNumbers
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetPhoneNumberReservation extends Binding.Service<
  GetPhoneNumberReservation,
  "Azure.Communication.GetPhoneNumberReservation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetPhoneNumberReservationRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersReservation,
      phoneNumbers.GetPhoneNumberReservationError,
      RuntimeContext
    >
  >
> {}

export const GetPhoneNumberReservation = Binding.Service<GetPhoneNumberReservation>(
  "Azure.Communication.GetPhoneNumberReservation",
);
