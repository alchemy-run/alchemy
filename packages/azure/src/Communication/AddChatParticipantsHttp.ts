import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { AddChatParticipants } from "./AddChatParticipants.ts";
import { makeChatHttpBinding } from "./BindingHttp.ts";

/**
 * Implementation of {@link AddChatParticipants} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.AddChatParticipants
 */
export const AddChatParticipantsHttp = Layer.effect(
  AddChatParticipants,
  makeChatHttpBinding({
    tag: "Azure.Communication.AddChatParticipants",
    operation: chat.AddChatThreadChatParticipants,
  }),
);
