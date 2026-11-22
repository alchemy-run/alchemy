import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetPhoneNumberReservation } from "./GetPhoneNumberReservation.ts";

/**
 * Implementation of {@link GetPhoneNumberReservation} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetPhoneNumberReservation
 */
export const GetPhoneNumberReservationHttp = Layer.effect(
  GetPhoneNumberReservation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetPhoneNumberReservation",
    operation: phoneNumbers.GetPhoneNumberReservation,
    grant: CommunicationRole.Data,
  }),
);
