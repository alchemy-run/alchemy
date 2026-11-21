import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { ScheduleMessage } from "./ScheduleMessage.ts";

/**
 * Bot-token implementation of {@link ScheduleMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.ScheduleMessage
 */
export const ScheduleMessageHttp = Layer.effect(
  ScheduleMessage,
  makeChannelBinding({ name: "ScheduleMessage", operation: Chat.scheduleMessage }),
);
