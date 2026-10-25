import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { ReleasePhoneNumber } from "./ReleasePhoneNumber.ts";

/**
 * Implementation of {@link ReleasePhoneNumber} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.ReleasePhoneNumber
 */
export const ReleasePhoneNumberHttp = Layer.effect(
  ReleasePhoneNumber,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.ReleasePhoneNumber",
    operation: phoneNumbers.PhoneNumbersReleasePhoneNumber,
    grant: CommunicationRole.Data,
  }),
);
