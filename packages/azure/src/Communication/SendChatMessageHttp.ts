import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { SendChatMessage } from "./SendChatMessage.ts";

/**
 * Implementation of {@link SendChatMessage} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.SendChatMessage
 */
export const SendChatMessageHttp = Layer.effect(
  SendChatMessage,
  makeChatHttpBinding({
    tag: "Azure.Communication.SendChatMessage",
    operation: chat.SendChatThreadChatMessage,
  }),
);
