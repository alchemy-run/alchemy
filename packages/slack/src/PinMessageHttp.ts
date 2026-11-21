import * as Pins from "@distilled.cloud/slack/pins";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { PinMessage } from "./PinMessage.ts";

/**
 * Bot-token implementation of {@link PinMessage}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Pin
 * @provides Slack.PinMessage
 */
export const PinMessageHttp = Layer.effect(
  PinMessage,
  makeChannelBinding({ name: "PinMessage", operation: Pins.addPin }),
);
