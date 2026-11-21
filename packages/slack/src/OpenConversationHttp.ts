import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeWorkspaceBinding } from "./BindingHttp.ts";
import { OpenConversation } from "./OpenConversation.ts";

/**
 * Bot-token implementation of {@link OpenConversation}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.OpenConversation
 */
export const OpenConversationHttp = Layer.effect(
  OpenConversation,
  makeWorkspaceBinding({ name: "OpenConversation", operation: Conversations.conversationsOpen }),
);
