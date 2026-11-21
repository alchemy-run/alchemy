import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { PostEphemeral } from "./PostEphemeral.ts";

/**
 * Bot-token implementation of {@link PostEphemeral}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.PostEphemeral
 */
export const PostEphemeralHttp = Layer.effect(
  PostEphemeral,
  makeChannelBinding({ name: "PostEphemeral", operation: Chat.postEphemeral }),
);
