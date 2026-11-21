import * as Pins from "@distilled.cloud/slack/pins";
import * as Layer from "effect/Layer";
import { makeChannelBinding } from "./BindingHttp.ts";
import { ListPins } from "./ListPins.ts";

/**
 * Bot-token implementation of {@link ListPins}. Provide it on a Worker or
 * Function: it captures the host's `Slack.BotToken` and binds it into the host.
 *
 * @layer
 * @product Pin
 * @provides Slack.ListPins
 */
export const ListPinsHttp = Layer.effect(
  ListPins,
  makeChannelBinding({ name: "ListPins", operation: Pins.listPins }),
);
