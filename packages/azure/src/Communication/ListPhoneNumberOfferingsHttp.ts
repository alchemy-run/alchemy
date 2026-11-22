import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumberOfferings } from "./ListPhoneNumberOfferings.ts";

/**
 * Implementation of {@link ListPhoneNumberOfferings} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumberOfferings
 */
export const ListPhoneNumberOfferingsHttp = Layer.effect(
  ListPhoneNumberOfferings,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumberOfferings",
    operation: phoneNumbers.ListPhoneNumberOfferings,
    grant: CommunicationRole.Data,
  }),
);
