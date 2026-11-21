import * as Chat from "@distilled.cloud/slack/chat";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { GetPermalink } from "./GetPermalink.ts";

/**
 * Bot-token implementation of {@link GetPermalink}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Message
 * @provides Slack.GetPermalink
 */
export const GetPermalinkHttp = Layer.effect(
  GetPermalink,
  makeChannelBinding({ name: "GetPermalink", operation: Chat.getPermalink }),
);
