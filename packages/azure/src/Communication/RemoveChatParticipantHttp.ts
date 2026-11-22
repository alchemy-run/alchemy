import * as chat from "@distilled.cloud/azure/communication-chat";
import * as Layer from "effect/Layer";
import { makeChatHttpBinding } from "./BindingHttp.ts";
import { RemoveChatParticipant } from "./RemoveChatParticipant.ts";

/**
 * Implementation of {@link RemoveChatParticipant} over the distilled `communication-chat`
 * data plane. Sends the request's user access token; assigns no role.
 *
 * @layer
 * @provides Azure.Communication.RemoveChatParticipant
 */
export const RemoveChatParticipantHttp = Layer.effect(
  RemoveChatParticipant,
  makeChatHttpBinding({
    tag: "Azure.Communication.RemoveChatParticipant",
    operation: chat.RemoveChatThreadChatParticipant,
  }),
);
