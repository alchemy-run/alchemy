import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type InviteToChannelRequest = Omit<Conversations.InviteConversationRequest, "channel">;

/**
 * Invite members to the bound channel (`conversations.invite`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.InviteToChannelHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `channels:write.invites`, `groups:write.invites`, `channels:manage`, `groups:write`, `im:write`, `mpim:write`.
 *
 * ### Calling it at runtime
 * **Example:** Invite members to the bound channel
 * ```typescript
 * const invite = yield* Slack.InviteToChannel(alerts);
 * yield* invite({ users: "U0123456789,U0987654321" });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface InviteToChannel extends Binding.Service<
  InviteToChannel,
  "Slack.InviteToChannel",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: InviteToChannelRequest,
    ) => Effect.Effect<
      Conversations.InviteConversationResponse,
      Conversations.InviteConversationError,
      RuntimeContext
    >
  >
> {}

export const InviteToChannel = Binding.Service<InviteToChannel>("Slack.InviteToChannel");
