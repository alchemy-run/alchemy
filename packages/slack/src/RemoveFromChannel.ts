import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type RemoveFromChannelRequest = Omit<Conversations.ConversationsKickRequest, "channel">;

/**
 * Remove a member from the bound channel (`conversations.kick`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.RemoveFromChannelHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:write`, `channels:manage`.
 *
 * ### Calling it at runtime
 * **Example:** Remove a member from the bound channel
 * ```typescript
 * const remove = yield* Slack.RemoveFromChannel(alerts);
 * yield* remove({ user: "U0123456789" });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface RemoveFromChannel extends Binding.Service<
  RemoveFromChannel,
  "Slack.RemoveFromChannel",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: RemoveFromChannelRequest,
    ) => Effect.Effect<
      Conversations.ConversationsKickResponse,
      Conversations.ConversationsKickError,
      RuntimeContext
    >
  >
> {}

export const RemoveFromChannel = Binding.Service<RemoveFromChannel>("Slack.RemoveFromChannel");
