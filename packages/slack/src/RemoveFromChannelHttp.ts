import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { RemoveFromChannel } from "./RemoveFromChannel.ts";

/**
 * Bot-token implementation of {@link RemoveFromChannel}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.RemoveFromChannel
 */
export const RemoveFromChannelHttp = Layer.effect(
  RemoveFromChannel,
  makeChannelBinding({ name: "RemoveFromChannel", operation: Conversations.conversationsKick }),
);
