import type * as messages from "@distilled.cloud/azure/communication-messages";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { CommunicationService } from "./CommunicationService.ts";

export interface SendNotificationMessageRequest extends Omit<
  messages.SendNotificationMessagesOperationRequest,
  "endpoint"
> {}

/**
 * Send an Advanced Messaging (WhatsApp) notification from a registered
 * channel to users.
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
 * Provide {@link SendNotificationMessageHttp}.
 *
 * ### Calling SendNotificationMessage
 * **Example:** SendNotificationMessage from a Function
 * ```typescript
 * // init
 * const sendNotificationMessage = yield* Azure.Communication.SendNotificationMessage(acs);
 *
 * // runtime
 * const sent = yield* sendNotificationMessage({
 *   channelRegistrationId,
 *   to: ["+14255550123"],
 *   kind: "text",
 *   content: "Your order shipped.",
 * });
 * // sent.receipts[0].messageId
 * ```
 *
 * @binding
 * @category Communication
 */
export interface SendNotificationMessage extends Binding.Service<
  SendNotificationMessage,
  "Azure.Communication.SendNotificationMessage",
  (
    service: CommunicationService,
  ) => Effect.Effect<
    (
      request: SendNotificationMessageRequest,
    ) => Effect.Effect<
      messages.SendMessageResult,
      messages.SendNotificationMessagesOperationError,
      RuntimeContext
    >
  >
> {}

export const SendNotificationMessage = Binding.Service<SendNotificationMessage>(
  "Azure.Communication.SendNotificationMessage",
);
