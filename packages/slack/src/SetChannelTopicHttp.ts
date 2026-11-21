import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { SetChannelTopic } from "./SetChannelTopic.ts";

/**
 * Bot-token implementation of {@link SetChannelTopic}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.SetChannelTopic
 */
export const SetChannelTopicHttp = Layer.effect(
  SetChannelTopic,
  makeChannelBinding({ name: "SetChannelTopic", operation: Conversations.setTopic }),
);
