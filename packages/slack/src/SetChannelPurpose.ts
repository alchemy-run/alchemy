import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type SetChannelPurposeRequest = Omit<Conversations.SetPurposeRequest, "channel">;

/**
 * Set the bound channel's description (`conversations.setPurpose`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.SetChannelPurposeHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `channels:write.topic`, `groups:write.topic`, `mpim:write.topic`, `im:write.topic`, `channels:manage`, `groups:write`, `im:write`, `mpim:write`.
 *
 * ### Calling it at runtime
 * **Example:** Set the bound channel's description
 * ```typescript
 * const setPurpose = yield* Slack.SetChannelPurpose(alerts);
 * yield* setPurpose({ purpose: "Production alerts" });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface SetChannelPurpose extends Binding.Service<
  SetChannelPurpose,
  "Slack.SetChannelPurpose",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: SetChannelPurposeRequest,
    ) => Effect.Effect<
      Conversations.SetPurposeResponse,
      Conversations.SetPurposeError,
      RuntimeContext
    >
  >
> {}

export const SetChannelPurpose = Binding.Service<SetChannelPurpose>("Slack.SetChannelPurpose");
