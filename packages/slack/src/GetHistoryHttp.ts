import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { GetHistory } from "./GetHistory.ts";

/**
 * Bot-token implementation of {@link GetHistory}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.GetHistory
 */
export const GetHistoryHttp = Layer.effect(
  GetHistory,
  makeChannelBinding({ name: "GetHistory", operation: Conversations.conversationsHistory }),
);
