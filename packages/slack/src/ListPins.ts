import type * as Pins from "@distilled.cloud/slack/pins";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type ListPinsRequest = Omit<Pins.ListPinsRequest, "channel">;

/**
 * List the items pinned in the bound channel (`pins.list`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ListPinsHttp` on the Worker or Function.
 *
 * Needs the bot scope `pins:read`.
 *
 * ### Calling it at runtime
 * **Example:** List the items pinned in the bound channel
 * ```typescript
 * const pins = yield* Slack.ListPins(alerts);
 * const { items } = yield* pins({});
 * ```
 *
 * @binding
 * @product Pin
 */
export interface ListPins extends Binding.Service<
  ListPins,
  "Slack.ListPins",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: ListPinsRequest,
    ) => Effect.Effect<Pins.ListPinsResponse, Pins.ListPinsError, RuntimeContext>
  >
> {}

export const ListPins = Binding.Service<ListPins>("Slack.ListPins");
