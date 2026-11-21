import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type GetHistoryRequest = Omit<Conversations.ConversationsHistoryRequest, "channel">;

/**
 * Read the bound channel's message history, newest first (`conversations.history`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetHistoryHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `groups:history`, `im:history`, `mpim:history`, `channels:history`.
 *
 * ### Calling it at runtime
 * **Example:** Read the bound channel's message history, newest first
 * ```typescript
 * const history = yield* Slack.GetHistory(alerts);
 * const { messages } = yield* history({ limit: 20 });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface GetHistory extends Binding.Service<
  GetHistory,
  "Slack.GetHistory",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: GetHistoryRequest,
    ) => Effect.Effect<
      Conversations.ConversationsHistoryResponse,
      Conversations.ConversationsHistoryError,
      RuntimeContext
    >
  >
> {}

export const GetHistory = Binding.Service<GetHistory>("Slack.GetHistory");
