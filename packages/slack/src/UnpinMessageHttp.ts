import * as Pins from "@distilled.cloud/slack/pins";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { UnpinMessage } from "./UnpinMessage.ts";

/**
 * Bot-token implementation of {@link UnpinMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Pin
 * @provides Slack.UnpinMessage
 */
export const UnpinMessageHttp = Layer.effect(
  UnpinMessage,
  makeChannelBinding({ name: "UnpinMessage", operation: Pins.removePin }),
);
