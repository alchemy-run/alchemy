import * as Reactions from "@distilled.cloud/slack/reactions";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { GetReactions } from "./GetReactions.ts";

/**
 * Bot-token implementation of {@link GetReactions}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Reaction
 * @provides Slack.GetReactions
 */
export const GetReactionsHttp = Layer.effect(
  GetReactions,
  makeChannelBinding({ name: "GetReactions", operation: Reactions.getReaction }),
);
