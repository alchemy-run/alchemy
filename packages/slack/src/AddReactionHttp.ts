import * as Reactions from "@distilled.cloud/slack/reactions";
import * as Layer from "effect/Layer";
import { AddReaction } from "./AddReaction.ts";
import { makeChannelBinding } from "./BindingHttp.ts";

/**
 * Bot-token implementation of {@link AddReaction}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Reaction
 * @provides Slack.AddReaction
 */
export const AddReactionHttp = Layer.effect(
  AddReaction,
  makeChannelBinding({ name: "AddReaction", operation: Reactions.addReaction }),
);
