import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetPhoneNumberOperation } from "./GetPhoneNumberOperation.ts";

/**
 * Implementation of {@link GetPhoneNumberOperation} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.GetPhoneNumberOperation
 */
export const GetPhoneNumberOperationHttp = Layer.effect(
  GetPhoneNumberOperation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetPhoneNumberOperation",
    operation: phoneNumbers.GetPhoneNumberOperation,
    grant: CommunicationRole.Data,
  }),
);
