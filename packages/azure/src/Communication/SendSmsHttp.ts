import * as sms from "@distilled.cloud/azure/communication-sms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SendSms } from "./SendSms.ts";

/**
 * Implementation of {@link SendSms} over the distilled `communication-sms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.SendSms
 */
export const SendSmsHttp = Layer.effect(
  SendSms,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SendSms",
    operation: sms.SendSms,
    grant: CommunicationRole.Data,
  }),
);
