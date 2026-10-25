import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { ListChatMessages } from "./ListChatMessages.ts";

/**
 * Implementation of {@link ListChatMessages} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.ListChatMessages
 */
export const ListChatMessagesHttp = Layer.effect(
  ListChatMessages,
  makeChatHttpBinding({
    tag: "Azure.Communication.ListChatMessages",
    operation: chat.ListChatThreadChatMessages,
  }),
);
