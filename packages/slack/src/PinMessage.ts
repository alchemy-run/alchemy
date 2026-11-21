import type * as Pins from "@distilled.cloud/slack/pins";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type PinMessageRequest = Omit<Pins.AddPinRequest, "channel">;

/**
 * Pin a message in the bound channel (`pins.add`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.PinMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `pins:write`.
 *
 * ### Calling it at runtime
 * **Example:** Pin a message in the bound channel
 * ```typescript
 * const pin = yield* Slack.PinMessage(alerts);
 * yield* pin({ timestamp: sent.ts });
 * ```
 *
 * @binding
 * @product Pin
 */
export interface PinMessage extends Binding.Service<
  PinMessage,
  "Slack.PinMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: PinMessageRequest,
    ) => Effect.Effect<Pins.AddPinResponse, Pins.AddPinError, RuntimeContext>
  >
> {}

export const PinMessage = Binding.Service<PinMessage>("Slack.PinMessage");
