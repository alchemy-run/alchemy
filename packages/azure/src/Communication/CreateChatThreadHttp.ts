import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { CreateChatThread } from "./CreateChatThread.ts";

/**
 * Implementation of {@link CreateChatThread} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.CreateChatThread
 */
export const CreateChatThreadHttp = Layer.effect(
  CreateChatThread,
  makeChatHttpBinding({
    tag: "Azure.Communication.CreateChatThread",
    operation: chat.CreateChatChatThread,
  }),
);
