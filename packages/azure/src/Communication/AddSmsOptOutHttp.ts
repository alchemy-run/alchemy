import * as sms from "@distilled.cloud/azure/communication-sms";
import * as Layer from "effect/Layer";
import { AddSmsOptOut } from "./AddSmsOptOut.ts";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddSmsOptOut} over the distilled `communication-sms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.AddSmsOptOut
 */
export const AddSmsOptOutHttp = Layer.effect(
  AddSmsOptOut,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.AddSmsOptOut",
    operation: sms.AddOptOut,
    grant: CommunicationRole.Data,
  }),
);
