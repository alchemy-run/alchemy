import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { DeletePhoneNumberReservation } from "./DeletePhoneNumberReservation.ts";

/**
 * Implementation of {@link DeletePhoneNumberReservation} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.DeletePhoneNumberReservation
 */
export const DeletePhoneNumberReservationHttp = Layer.effect(
  DeletePhoneNumberReservation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.DeletePhoneNumberReservation",
    operation: phoneNumbers.DeletePhoneNumberReservation,
    grant: CommunicationRole.Data,
  }),
);
