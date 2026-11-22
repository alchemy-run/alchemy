import * as phoneNumbers from "@distilled.cloud/azure/communication-phone-numbers";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { PurchasePhoneNumbers } from "./PurchasePhoneNumbers.ts";

/**
 * Implementation of {@link PurchasePhoneNumbers} over the distilled
 * `communication-phone-numbers` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.PurchasePhoneNumbers
 */
export const PurchasePhoneNumbersHttp = Layer.effect(
  PurchasePhoneNumbers,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.PurchasePhoneNumbers",
    operation: phoneNumbers.PhoneNumbersPurchasePhoneNumbers,
    grant: CommunicationRole.Data,
  }),
);
