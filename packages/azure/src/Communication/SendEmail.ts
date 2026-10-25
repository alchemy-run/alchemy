import type * as email from "@distilled.cloud/azure/communication-email";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SendEmailRequest extends Omit<email.SendEmailRequest, "endpoint"> {}

/**
 * Queue an email from a sender address on an email domain linked to the
 * communication service (`linkedDomains`). The response carries the
 * operation `id`; read its status with {@link GetEmailSendResult}.
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
 * Provide {@link SendEmailHttp}.
 *
 * ### Calling SendEmail
 * **Example:** SendEmail from a Function
 * ```typescript
 * // init
 * const sendEmail = yield* Azure.Communication.SendEmail(acs);
 *
 * // runtime
 * const sent = yield* sendEmail({
 *   senderAddress: "DoNotReply@contoso.com",
 *   content: { subject: "Welcome", plainText: "Hello from Azure" },
 *   recipients: { to: [{ address: "user@example.com" }] },
 * });
 * // sent.id → operation id, sent.status → "Running"
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendEmail extends Binding.Service<
  SendEmail,
  "Azure.Communication.SendEmail",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendEmailRequest,
    ) => Effect.Effect<email.SendEmailResponse, email.SendEmailError, RuntimeContext>
  >
> {}

export const SendEmail = Binding.Service<SendEmail>("Azure.Communication.SendEmail");
