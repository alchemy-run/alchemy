import type * as sms from "@distilled.cloud/azure/communication-sms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface GetSmsDeliveryReportRequest extends Omit<
  sms.GetDeliveryReportRequest,
  "endpoint"
> {}

/**
 * Read the delivery report of an SMS sent with {@link SendSms}
 * (`smsSendOptions.enableDeliveryReport`).
 *
 * Binding assigns a custom role (`AzureCommunicationDataRole`, one per stack)
 * with exactly the actions `Microsoft.Communication/CommunicationServices/Read`
 * and `/Write`, on the communication service only. The Communication
 * Services data plane has no data actions and denies Entra callers without
 * both, reads included.
 * On a host with a managed identity (an Azure Function, Function App, Web
 * App, Container App, container group, VM, or AKS workload identity) the
 * role goes to that identity; any other host (a Cloudflare Worker, an AWS
 * Lambda) gets an Entra service principal (see `AzureBindings`).
 * Provide {@link GetSmsDeliveryReportHttp}.
 *
 * ### Calling GetSmsDeliveryReport
 * **Example:** GetSmsDeliveryReport from a Function
 * ```typescript
 * // init
 * const getSmsDeliveryReport = yield* Azure.Communication.GetSmsDeliveryReport(acs);
 *
 * // runtime
 * const report = yield* getSmsDeliveryReport({ outgoingMessageId: messageId });
 * // report.deliveryStatus → "Delivered" | "Failed"
 * ```
 *
 * @binding
 * @category Communication
 */
export interface GetSmsDeliveryReport extends Binding.Service<
  GetSmsDeliveryReport,
  "Azure.Communication.GetSmsDeliveryReport",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: GetSmsDeliveryReportRequest,
    ) => Effect.Effect<sms.DeliveryReport, sms.GetDeliveryReportError, RuntimeContext>
  >
> {}

export const GetSmsDeliveryReport = Binding.Service<GetSmsDeliveryReport>(
  "Azure.Communication.GetSmsDeliveryReport",
);
