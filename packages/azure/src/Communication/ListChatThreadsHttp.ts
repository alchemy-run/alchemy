import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { ListChatThreads } from "./ListChatThreads.ts";

/**
 * Implementation of {@link ListChatThreads} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.ListChatThreads
 */
export const ListChatThreadsHttp = Layer.effect(
  ListChatThreads,
  makeChatHttpBinding({
    tag: "Azure.Communication.ListChatThreads",
    operation: chat.ListChatChatThreads,
  }),
);
