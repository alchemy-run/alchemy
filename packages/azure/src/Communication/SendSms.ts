import type * as sms from "@distilled.cloud/azure/communication-sms";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SendSmsRequest extends Omit<sms.SendSmsRequest, "endpoint"> {}

/**
 * Send an SMS from a phone number the communication service owns (purchase
 * one with the Phone Numbers API).
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
 * Provide {@link SendSmsHttp}.
 *
 * ### Calling SendSms
 * **Example:** SendSms from a Function
 * ```typescript
 * // init
 * const sendSms = yield* Azure.Communication.SendSms(acs);
 *
 * // runtime
 * const sent = yield* sendSms({
 *   from: "+18005550100",
 *   smsRecipients: [{ to: "+14255550123" }],
 *   message: "Your code is 123456",
 * });
 * // sent.value[0].messageId, sent.value[0].successful
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendSms extends Binding.Service<
  SendSms,
  "Azure.Communication.SendSms",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendSmsRequest,
    ) => Effect.Effect<sms.SmsSendResponse, sms.SendSmsError, RuntimeContext>
  >
> {}

export const SendSms = Binding.Service<SendSms>("Azure.Communication.SendSms");
