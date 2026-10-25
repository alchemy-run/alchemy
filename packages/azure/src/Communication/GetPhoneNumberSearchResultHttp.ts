import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetPhoneNumberSearchResult } from "./GetPhoneNumberSearchResult.ts";

/**
 * Implementation of {@link GetPhoneNumberSearchResult} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetPhoneNumberSearchResult
 */
export const GetPhoneNumberSearchResultHttp = Layer.effect(
  GetPhoneNumberSearchResult,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetPhoneNumberSearchResult",
    operation: phoneNumbers.PhoneNumbersGetSearchResult,
    grant: CommunicationRole.Data,
  }),
);
