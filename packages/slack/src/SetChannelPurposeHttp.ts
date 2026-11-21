import * as Conversations from "@distilled.cloud/slack/conversations";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { SetChannelPurpose } from "./SetChannelPurpose.ts";

/**
 * Bot-token implementation of {@link SetChannelPurpose}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Channel
 * @provides Slack.SetChannelPurpose
 */
export const SetChannelPurposeHttp = Layer.effect(
  SetChannelPurpose,
  makeChannelBinding({ name: "SetChannelPurpose", operation: Conversations.setPurpose }),
);
