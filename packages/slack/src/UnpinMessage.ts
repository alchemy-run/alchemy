import type * as Pins from "@distilled.cloud/slack/pins";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type UnpinMessageRequest = Omit<Pins.RemovePinRequest, "channel">;

/**
 * Unpin a message in the bound channel (`pins.remove`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.UnpinMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `pins:write`.
 *
 * ### Calling it at runtime
 * **Example:** Unpin a message in the bound channel
 * ```typescript
 * const unpin = yield* Slack.UnpinMessage(alerts);
 * yield* unpin({ timestamp: sent.ts });
 * ```
 *
 * @binding
 * @product Pin
 */
export interface UnpinMessage extends Binding.Service<
  UnpinMessage,
  "Slack.UnpinMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: UnpinMessageRequest,
    ) => Effect.Effect<Pins.RemovePinResponse, Pins.RemovePinError, RuntimeContext>
  >
> {}

export const UnpinMessage = Binding.Service<UnpinMessage>("Slack.UnpinMessage");
