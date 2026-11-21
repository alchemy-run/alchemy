import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { UpdateMessage } from "./UpdateMessage.ts";

/**
 * Bot-token implementation of {@link UpdateMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.UpdateMessage
 */
export const UpdateMessageHttp = Layer.effect(
  UpdateMessage,
  makeChannelBinding({ name: "UpdateMessage", operation: Chat.updateChat }),
);
