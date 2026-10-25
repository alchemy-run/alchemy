import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { DeleteChatThread } from "./DeleteChatThread.ts";

/**
 * Implementation of {@link DeleteChatThread} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.DeleteChatThread
 */
export const DeleteChatThreadHttp = Layer.effect(
  DeleteChatThread,
  makeChatHttpBinding({
    tag: "Azure.Communication.DeleteChatThread",
    operation: chat.DeleteChatChatThread,
  }),
);
