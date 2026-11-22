import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumbers } from "./ListPhoneNumbers.ts";

/**
 * Implementation of {@link ListPhoneNumbers} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumbers
 */
export const ListPhoneNumbersHttp = Layer.effect(
  ListPhoneNumbers,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumbers",
    operation: phoneNumbers.ListPhoneNumberPhoneNumbers,
    grant: CommunicationRole.Data,
  }),
);
