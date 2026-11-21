import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type GetChannelInfoRequest = Omit<Conversations.ConversationsInfoRequest, "channel">;

/**
 * Read the bound channel's details (`conversations.info`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetChannelInfoHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:read`, `im:read`, `mpim:read`, `channels:read`.
 *
 * ### Calling it at runtime
 * **Example:** Read the bound channel's details
 * ```typescript
 * const info = yield* Slack.GetChannelInfo(alerts);
 * const { channel } = yield* info({ include_num_members: true });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface GetChannelInfo extends Binding.Service<
  GetChannelInfo,
  "Slack.GetChannelInfo",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: GetChannelInfoRequest,
    ) => Effect.Effect<
      Conversations.ConversationsInfoResponse,
      Conversations.ConversationsInfoError,
      RuntimeContext
    >
  >
> {}

export const GetChannelInfo = Binding.Service<GetChannelInfo>("Slack.GetChannelInfo");
