import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { GetReplies } from "./GetReplies.ts";

/**
 * Bot-token implementation of {@link GetReplies}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.GetReplies
 */
export const GetRepliesHttp = Layer.effect(
  GetReplies,
  makeChannelBinding({ name: "GetReplies", operation: Conversations.conversationsReplies }),
);
