import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetPhoneNumber } from "./GetPhoneNumber.ts";

/**
 * Implementation of {@link GetPhoneNumber} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetPhoneNumber
 */
export const GetPhoneNumberHttp = Layer.effect(
  GetPhoneNumber,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetPhoneNumber",
    operation: phoneNumbers.GetPhoneNumberByNumber,
    grant: CommunicationRole.Data,
  }),
);
