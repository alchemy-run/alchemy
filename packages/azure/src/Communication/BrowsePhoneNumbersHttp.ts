import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { BrowsePhoneNumbers } from "./BrowsePhoneNumbers.ts";

/**
 * Implementation of {@link BrowsePhoneNumbers} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.BrowsePhoneNumbers
 */
export const BrowsePhoneNumbersHttp = Layer.effect(
  BrowsePhoneNumbers,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.BrowsePhoneNumbers",
    operation: phoneNumbers.PhoneNumbersBrowseAvailableNumbers,
    grant: CommunicationRole.Data,
  }),
);
