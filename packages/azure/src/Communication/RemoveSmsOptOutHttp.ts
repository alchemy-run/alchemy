import * as sms from "@distilled.cloud/azure/communication-sms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { RemoveSmsOptOut } from "./RemoveSmsOptOut.ts";

/**
 * Implementation of {@link RemoveSmsOptOut} over the distilled `communication-sms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.RemoveSmsOptOut
 */
export const RemoveSmsOptOutHttp = Layer.effect(
  RemoveSmsOptOut,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.RemoveSmsOptOut",
    operation: sms.RemoveOptOut,
    grant: CommunicationRole.Data,
  }),
);
