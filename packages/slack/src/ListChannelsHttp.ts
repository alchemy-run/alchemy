import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { ListChannels } from "./ListChannels.ts";

/**
 * Bot-token implementation of {@link ListChannels}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.ListChannels
 */
export const ListChannelsHttp = Layer.effect(
  ListChannels,
  makeWorkspaceBinding({ name: "ListChannels", operation: Conversations.listConversations }),
);
