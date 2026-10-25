import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { PurchasePhoneNumberReservation } from "./PurchasePhoneNumberReservation.ts";

/**
 * Implementation of {@link PurchasePhoneNumberReservation} over the
 * distilled `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.PurchasePhoneNumberReservation
 */
export const PurchasePhoneNumberReservationHttp = Layer.effect(
  PurchasePhoneNumberReservation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.PurchasePhoneNumberReservation",
    operation: phoneNumbers.PhoneNumbersPurchaseReservation,
    grant: CommunicationRole.Data,
  }),
);
