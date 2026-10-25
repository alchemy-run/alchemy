import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SearchPhoneNumbers } from "./SearchPhoneNumbers.ts";

/**
 * Implementation of {@link SearchPhoneNumbers} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.SearchPhoneNumbers
 */
export const SearchPhoneNumbersHttp = Layer.effect(
  SearchPhoneNumbers,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SearchPhoneNumbers",
    operation: phoneNumbers.SearchPhoneNumberAvailablePhoneNumbers,
    grant: CommunicationRole.Data,
  }),
);
