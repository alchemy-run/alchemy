import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { GetChatMessage } from "./GetChatMessage.ts";

/**
 * Implementation of {@link GetChatMessage} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.GetChatMessage
 */
export const GetChatMessageHttp = Layer.effect(
  GetChatMessage,
  makeChatHttpBinding({
    tag: "Azure.Communication.GetChatMessage",
    operation: chat.GetChatThreadChatMessage,
  }),
);
