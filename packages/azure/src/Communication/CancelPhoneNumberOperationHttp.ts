import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CancelPhoneNumberOperation } from "./CancelPhoneNumberOperation.ts";

/**
 * Implementation of {@link CancelPhoneNumberOperation} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.CancelPhoneNumberOperation
 */
export const CancelPhoneNumberOperationHttp = Layer.effect(
  CancelPhoneNumberOperation,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CancelPhoneNumberOperation",
    operation: phoneNumbers.CancelPhoneNumberOperation,
    grant: CommunicationRole.Data,
  }),
);
