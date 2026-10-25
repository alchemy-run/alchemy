import type * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface PurchasePhoneNumberReservationRequest extends Omit<
  phoneNumbers.PhoneNumbersPurchaseReservationRequest,
  "endpoint"
> {}

/**
 * Purchase every phone number in an active reservation. Purchased numbers
 * are billed monthly.
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
 * Provide {@link PurchasePhoneNumberReservationHttp}.
 *
 * ### Calling PurchasePhoneNumberReservation
 * **Example:** PurchasePhoneNumberReservation from a Function
 * ```typescript
 * // init
 * const purchasePhoneNumberReservation = yield* Azure.Communication.PurchasePhoneNumberReservation(acs);
 *
 * // runtime
 * const purchase = yield* purchasePhoneNumberReservation({ reservationId, agreeToNotResell: true });
 * // purchase.operationLocation
 * ```
 *
 * @binding
 * @category Communication
 */
export interface PurchasePhoneNumberReservation extends Binding.Service<
  PurchasePhoneNumberReservation,
  "Azure.Communication.PurchasePhoneNumberReservation",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: PurchasePhoneNumberReservationRequest,
    ) => Effect.Effect<
      phoneNumbers.PhoneNumbersPurchaseReservationResponse,
      phoneNumbers.PhoneNumbersPurchaseReservationError,
      RuntimeContext
    >
  >
> {}

export const PurchasePhoneNumberReservation = Binding.Service<PurchasePhoneNumberReservation>(
  "Azure.Communication.PurchasePhoneNumberReservation",
);
