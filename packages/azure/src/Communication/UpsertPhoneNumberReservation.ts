import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface UpsertPhoneNumberReservationRequest extends Omit<
  phoneNumbers.PhoneNumbersCreateOrUpdateReservationRequest,
  "endpoint"
> {}

/**
 * Create or update a phone number reservation: add numbers by ID, or set a
 * number to `null` to remove it. The reservation expires 15 minutes after
 * its last change.
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
 * Provide {@link UpsertPhoneNumberReservationHttp}.
 *
 * ### Calling UpsertPhoneNumberReservation
 * **Example:** UpsertPhoneNumberReservation from a Function
 * ```typescript
 * // init
 * const upsertPhoneNumberReservation = yield* Azure.Communication.UpsertPhoneNumberReservation(acs);
 *
 * // runtime
 * const reservation = yield* upsertPhoneNumberReservation({
 *   reservationId,
 *   phoneNumbers: { [number.id]: number },
 * });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface UpsertPhoneNumberReservation extends Binding.Service<
  UpsertPhoneNumberReservation,
  "Azure.Communication.UpsertPhoneNumberReservation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: UpsertPhoneNumberReservationRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersReservation,
      phoneNumbers.PhoneNumbersCreateOrUpdateReservationError,
      RuntimeContext
    >
  >
> {}

export const UpsertPhoneNumberReservation = Binding.Service<UpsertPhoneNumberReservation>(
  "Azure.Communication.UpsertPhoneNumberReservation",
);
