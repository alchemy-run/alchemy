import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface DeletePhoneNumberReservationRequest extends Omit<
  phoneNumbers.DeletePhoneNumberReservationRequest,
  "endpoint"
> {}

/**
 * Delete an active phone number reservation and release its numbers.
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
 * Provide {@link DeletePhoneNumberReservationHttp}.
 *
 * ### Calling DeletePhoneNumberReservation
 * **Example:** DeletePhoneNumberReservation from a Function
 * ```typescript
 * // init
 * const deletePhoneNumberReservation = yield* Azure.Communication.DeletePhoneNumberReservation(acs);
 *
 * // runtime
 * yield* deletePhoneNumberReservation({ reservationId });
 * ```
 *
 * @binding
 * @category Communication
 */
export interface DeletePhoneNumberReservation extends Binding.Service<
  DeletePhoneNumberReservation,
  "Azure.Communication.DeletePhoneNumberReservation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: DeletePhoneNumberReservationRequest,
    ) => Effect.Effect<
      phoneNumbers.DeletePhoneNumberReservationResponse,
      phoneNumbers.DeletePhoneNumberReservationError,
      RuntimeContext
    >
  >
> {}

export const DeletePhoneNumberReservation = Binding.Service<DeletePhoneNumberReservation>(
  "Azure.Communication.DeletePhoneNumberReservation",
);
