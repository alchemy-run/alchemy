import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { UpdatePhoneNumberCapabilities } from "./UpdatePhoneNumberCapabilities.ts";

/**
 * Implementation of {@link UpdatePhoneNumberCapabilities} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.UpdatePhoneNumberCapabilities
 */
export const UpdatePhoneNumberCapabilitiesHttp = Layer.effect(
  UpdatePhoneNumberCapabilities,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.UpdatePhoneNumberCapabilities",
    operation: phoneNumbers.UpdatePhoneNumberCapabilities,
    grant: CommunicationRole.Data,
  }),
);
