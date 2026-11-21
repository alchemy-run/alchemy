import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { ListScheduledMessages } from "./ListScheduledMessages.ts";

/**
 * Bot-token implementation of {@link ListScheduledMessages}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.ListScheduledMessages
 */
export const ListScheduledMessagesHttp = Layer.effect(
  ListScheduledMessages,
  makeChannelBinding({ name: "ListScheduledMessages", operation: Chat.listScheduledMessages }),
);
