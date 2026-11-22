import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumberLocalities } from "./ListPhoneNumberLocalities.ts";

/**
 * Implementation of {@link ListPhoneNumberLocalities} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumberLocalities
 */
export const ListPhoneNumberLocalitiesHttp = Layer.effect(
  ListPhoneNumberLocalities,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumberLocalities",
    operation: phoneNumbers.ListPhoneNumberAvailableLocalities,
    grant: CommunicationRole.Data,
  }),
);
