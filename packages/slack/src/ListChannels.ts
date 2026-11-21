import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export type ListChannelsRequest = Conversations.ListConversationsRequest;

/**
 * List the workspace's channels (`conversations.list`). Workspace-wide: it binds to no resource.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ListChannelsHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:read`, `im:read`, `mpim:read`, `channels:read`.
 *
 * ### Calling it at runtime
 * **Example:** List the workspace's channels
 * ```typescript
 * const listChannels = yield* Slack.ListChannels();
 * const { channels } = yield* listChannels({ types: "public_channel", limit: 200 });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface ListChannels extends Binding.Service<
  ListChannels,
  "Slack.ListChannels",
  () => Effect.Effect<
    (
      request: ListChannelsRequest,
    ) => Effect.Effect<
      Conversations.ListConversationsResponse,
      Conversations.ListConversationsError,
      RuntimeContext
    >
  >
> {}

export const ListChannels = Binding.Service<ListChannels>("Slack.ListChannels");
