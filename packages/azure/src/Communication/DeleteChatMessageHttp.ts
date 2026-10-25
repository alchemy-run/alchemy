import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { DeleteChatMessage } from "./DeleteChatMessage.ts";

/**
 * Implementation of {@link DeleteChatMessage} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.DeleteChatMessage
 */
export const DeleteChatMessageHttp = Layer.effect(
  DeleteChatMessage,
  makeChatHttpBinding({
    tag: "Azure.Communication.DeleteChatMessage",
    operation: chat.DeleteChatThreadChatMessage,
  }),
);
