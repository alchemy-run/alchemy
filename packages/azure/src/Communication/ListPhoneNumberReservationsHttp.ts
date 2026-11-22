import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumberReservations } from "./ListPhoneNumberReservations.ts";

/**
 * Implementation of {@link ListPhoneNumberReservations} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumberReservations
 */
export const ListPhoneNumberReservationsHttp = Layer.effect(
  ListPhoneNumberReservations,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumberReservations",
    operation: phoneNumbers.ListPhoneNumberReservations,
    grant: CommunicationRole.Data,
  }),
);
