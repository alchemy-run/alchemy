import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { SendChatTypingNotification } from "./SendChatTypingNotification.ts";

/**
 * Implementation of {@link SendChatTypingNotification} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.SendChatTypingNotification
 */
export const SendChatTypingNotificationHttp = Layer.effect(
  SendChatTypingNotification,
  makeChatHttpBinding({
    tag: "Azure.Communication.SendChatTypingNotification",
    operation: chat.SendChatThreadTypingNotification,
  }),
);
