import * as sms from "@distilled.cloud/azure/communication-sms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { CheckSmsOptOut } from "./CheckSmsOptOut.ts";

/**
 * Implementation of {@link CheckSmsOptOut} over the distilled `communication-sms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.CheckSmsOptOut
 */
export const CheckSmsOptOutHttp = Layer.effect(
  CheckSmsOptOut,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.CheckSmsOptOut",
    operation: sms.CheckOptOut,
    grant: CommunicationRole.Data,
  }),
);
