import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpsertPhoneNumberReservation } from "./UpsertPhoneNumberReservation.ts";

/**
 * Implementation of {@link UpsertPhoneNumberReservation} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpsertPhoneNumberReservation
 */
export const UpsertPhoneNumberReservationHttp = Layer.effect(
  UpsertPhoneNumberReservation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpsertPhoneNumberReservation",
    operation: phoneNumbers.PhoneNumbersCreateOrUpdateReservation,
    grant: CommunicationRole.Data,
  }),
);
