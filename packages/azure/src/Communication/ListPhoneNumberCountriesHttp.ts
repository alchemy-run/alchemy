import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumberCountries } from "./ListPhoneNumberCountries.ts";

/**
 * Implementation of {@link ListPhoneNumberCountries} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumberCountries
 */
export const ListPhoneNumberCountriesHttp = Layer.effect(
  ListPhoneNumberCountries,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumberCountries",
    operation: phoneNumbers.ListPhoneNumberAvailableCountries,
    grant: CommunicationRole.Data,
  }),
);
