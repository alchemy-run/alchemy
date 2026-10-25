import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { ListChatReadReceipts } from "./ListChatReadReceipts.ts";

/**
 * Implementation of {@link ListChatReadReceipts} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.ListChatReadReceipts
 */
export const ListChatReadReceiptsHttp = Layer.effect(
  ListChatReadReceipts,
  makeChatHttpBinding({
    tag: "Azure.Communication.ListChatReadReceipts",
    operation: chat.ChatThreadListChatReadReceipts,
  }),
);
