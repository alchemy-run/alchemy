import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { DeleteScheduledMessage } from "./DeleteScheduledMessage.ts";

/**
 * Bot-token implementation of {@link DeleteScheduledMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.DeleteScheduledMessage
 */
export const DeleteScheduledMessageHttp = Layer.effect(
  DeleteScheduledMessage,
  makeChannelBinding({ name: "DeleteScheduledMessage", operation: Chat.deleteScheduledMessage }),
);
