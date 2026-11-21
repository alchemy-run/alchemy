import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { ListChannelMembers } from "./ListChannelMembers.ts";

/**
 * Bot-token implementation of {@link ListChannelMembers}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.ListChannelMembers
 */
export const ListChannelMembersHttp = Layer.effect(
  ListChannelMembers,
  makeChannelBinding({ name: "ListChannelMembers", operation: Conversations.conversationsMembers }),
);
