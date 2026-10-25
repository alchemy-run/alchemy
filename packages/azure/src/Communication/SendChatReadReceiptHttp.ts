import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { SendChatReadReceipt } from "./SendChatReadReceipt.ts";

/**
 * Implementation of {@link SendChatReadReceipt} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.SendChatReadReceipt
 */
export const SendChatReadReceiptHttp = Layer.effect(
  SendChatReadReceipt,
  makeChatHttpBinding({
    tag: "Azure.Communication.SendChatReadReceipt",
    operation: chat.ChatThreadSendChatReadReceipt,
  }),
);
