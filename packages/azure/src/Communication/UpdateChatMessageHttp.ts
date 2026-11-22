import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { UpdateChatMessage } from "./UpdateChatMessage.ts";

/**
 * Implementation of {@link UpdateChatMessage} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.UpdateChatMessage
 */
export const UpdateChatMessageHttp = Layer.effect(
  UpdateChatMessage,
  makeChatHttpBinding({
    tag: "Azure.Communication.UpdateChatMessage",
    operation: chat.UpdateChatThreadChatMessage,
  }),
);
