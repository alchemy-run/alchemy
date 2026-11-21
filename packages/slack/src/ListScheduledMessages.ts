import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type ListScheduledMessagesRequest = Omit<Chat.ListScheduledMessagesRequest, "channel">;

/**
 * List the messages scheduled in the bound channel (`chat.scheduledMessages.list`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ListScheduledMessagesHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** List the messages scheduled in the bound channel
 * ```typescript
 * const list = yield* Slack.ListScheduledMessages(alerts);
 * const { scheduled_messages } = yield* list({});
 * ```
 *
 * @binding
 * @product Message
 */
export interface ListScheduledMessages extends Binding.Service<
  ListScheduledMessages,
  "Slack.ListScheduledMessages",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: ListScheduledMessagesRequest,
    ) => Effect.Effect<
      Chat.ListScheduledMessagesResponse,
      Chat.ListScheduledMessagesError,
      RuntimeContext
    >
  >
> {}

export const ListScheduledMessages = Binding.Service<ListScheduledMessages>(
  "Slack.ListScheduledMessages",
);
