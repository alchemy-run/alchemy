import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SearchPhoneNumberOperatorInformation } from "./SearchPhoneNumberOperatorInformation.ts";

/**
 * Implementation of {@link SearchPhoneNumberOperatorInformation} over the
 * distilled `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.SearchPhoneNumberOperatorInformation
 */
export const SearchPhoneNumberOperatorInformationHttp = Layer.effect(
  SearchPhoneNumberOperatorInformation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SearchPhoneNumberOperatorInformation",
    operation: phoneNumbers.SearchPhoneNumbersOperatorInformation,
    grant: CommunicationRole.Data,
  }),
);
