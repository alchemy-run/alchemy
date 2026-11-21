import * as Reactions from "@distilled.cloud/slack/reactions";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { RemoveReaction } from "./RemoveReaction.ts";

/**
 * Bot-token implementation of {@link RemoveReaction}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Reaction
 * @provides Slack.RemoveReaction
 */
export const RemoveReactionHttp = Layer.effect(
  RemoveReaction,
  makeChannelBinding({ name: "RemoveReaction", operation: Reactions.removeReaction }),
);
