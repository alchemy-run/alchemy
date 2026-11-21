import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { PostMessage } from "./PostMessage.ts";

/**
 * Bot-token implementation of {@link PostMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.PostMessage
 */
export const PostMessageHttp = Layer.effect(
  PostMessage,
  makeChannelBinding({ name: "PostMessage", operation: Chat.postMessage }),
);
