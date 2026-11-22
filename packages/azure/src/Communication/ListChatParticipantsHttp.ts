import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { ListChatParticipants } from "./ListChatParticipants.ts";

/**
 * Implementation of {@link ListChatParticipants} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.ListChatParticipants
 */
export const ListChatParticipantsHttp = Layer.effect(
  ListChatParticipants,
  makeChatHttpBinding({
    tag: "Azure.Communication.ListChatParticipants",
    operation: chat.ListChatThreadChatParticipants,
  }),
);
