import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type ListChannelMembersRequest = Omit<Conversations.ConversationsMembersRequest, "channel">;

/**
 * List the members of the bound channel (`conversations.members`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ListChannelMembersHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:read`, `im:read`, `mpim:read`, `channels:read`.
 *
 * ### Calling it at runtime
 * **Example:** List the members of the bound channel
 * ```typescript
 * const members = yield* Slack.ListChannelMembers(alerts);
 * const { members: userIds } = yield* members({});
 * ```
 *
 * @binding
 * @product Channel
 */
export interface ListChannelMembers extends Binding.Service<
  ListChannelMembers,
  "Slack.ListChannelMembers",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: ListChannelMembersRequest,
    ) => Effect.Effect<
      Conversations.ConversationsMembersResponse,
      Conversations.ConversationsMembersError,
      RuntimeContext
    >
  >
> {}

export const ListChannelMembers = Binding.Service<ListChannelMembers>("Slack.ListChannelMembers");
