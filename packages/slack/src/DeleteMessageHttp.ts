import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { DeleteMessage } from "./DeleteMessage.ts";

/**
 * Bot-token implementation of {@link DeleteMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.DeleteMessage
 */
export const DeleteMessageHttp = Layer.effect(
  DeleteMessage,
  makeChannelBinding({ name: "DeleteMessage", operation: Chat.deleteChat }),
);
