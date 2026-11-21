import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type GetRepliesRequest = Omit<Conversations.ConversationsRepliesRequest, "channel">;

/**
 * Read a thread in the bound channel (`conversations.replies`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetRepliesHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:history`, `im:history`, `mpim:history`, `channels:history`.
 *
 * ### Calling it at runtime
 * **Example:** Read a thread in the bound channel
 * ```typescript
 * const replies = yield* Slack.GetReplies(alerts);
 * const { messages } = yield* replies({ ts: sent.ts });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface GetReplies extends Binding.Service<
  GetReplies,
  "Slack.GetReplies",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: GetRepliesRequest,
    ) => Effect.Effect<
      Conversations.ConversationsRepliesResponse,
      Conversations.ConversationsRepliesError,
      RuntimeContext
    >
  >
> {}

export const GetReplies = Binding.Service<GetReplies>("Slack.GetReplies");
