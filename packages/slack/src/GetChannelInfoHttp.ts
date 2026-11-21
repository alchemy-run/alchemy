import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { GetChannelInfo } from "./GetChannelInfo.ts";

/**
 * Bot-token implementation of {@link GetChannelInfo}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.GetChannelInfo
 */
export const GetChannelInfoHttp = Layer.effect(
  GetChannelInfo,
  makeChannelBinding({ name: "GetChannelInfo", operation: Conversations.conversationsInfo }),
);
