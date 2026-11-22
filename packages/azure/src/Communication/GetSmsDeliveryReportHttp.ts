import * as sms from "@distilled.cloud/azure/communication-sms";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { GetSmsDeliveryReport } from "./GetSmsDeliveryReport.ts";

/**
 * Implementation of {@link GetSmsDeliveryReport} over the distilled `communication-sms`
 * data plane. Assigns the custom `AzureCommunicationDataRole` on the
 * communication service.
 *
 * @layer
 * @provides Azure.Communication.GetSmsDeliveryReport
 */
export const GetSmsDeliveryReportHttp = Layer.effect(
  GetSmsDeliveryReport,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.GetSmsDeliveryReport",
    operation: sms.GetDeliveryReport,
    grant: CommunicationRole.Data,
  }),
);
