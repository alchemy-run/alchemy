import * as messages from "@distilled.cloud/azure/communication-messages";
import * as Layer from "effect/Layer";
import { CommunicationRole, makeCommunicationHttpBinding } from "./BindingHttp.ts";
import { SendNotificationMessage } from "./SendNotificationMessage.ts";

/**
 * Implementation of {@link SendNotificationMessage} over the distilled
 * `communication-messages` data plane. Assigns the custom
 * `AzureCommunicationDataRole` on the communication service.
 *
 * @layer
 * @provides Azure.Communication.SendNotificationMessage
 */
export const SendNotificationMessageHttp = Layer.effect(
  SendNotificationMessage,
  makeCommunicationHttpBinding({
    tag: "Azure.Communication.SendNotificationMessage",
    operation: messages.SendNotificationMessagesOperation,
    grant: CommunicationRole.Data,
  }),
);
