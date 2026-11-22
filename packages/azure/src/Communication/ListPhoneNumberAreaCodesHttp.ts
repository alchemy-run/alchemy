import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ListPhoneNumberAreaCodes } from "./ListPhoneNumberAreaCodes.ts";

/**
 * Implementation of {@link ListPhoneNumberAreaCodes} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ListPhoneNumberAreaCodes
 */
export const ListPhoneNumberAreaCodesHttp = Layer.effect(
  ListPhoneNumberAreaCodes,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ListPhoneNumberAreaCodes",
    operation: phoneNumbers.ListPhoneNumberAreaCodes,
    grant: CommunicationRole.Data,
  }),
);
