import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { InviteToChannel } from "./InviteToChannel.ts";

/**
 * Bot-token implementation of {@link InviteToChannel}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.InviteToChannel
 */
export const InviteToChannelHttp = Layer.effect(
  InviteToChannel,
  makeChannelBinding({ name: "InviteToChannel", operation: Conversations.inviteConversation }),
);
