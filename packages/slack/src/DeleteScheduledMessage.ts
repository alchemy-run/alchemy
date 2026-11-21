import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type DeleteScheduledMessageRequest = Omit<Chat.DeleteScheduledMessageRequest, "channel">;

/**
 * Cancel a scheduled message in the bound channel (`chat.deleteScheduledMessage`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.DeleteScheduledMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Cancel a scheduled message in the bound channel
 * ```typescript
 * const cancel = yield* Slack.DeleteScheduledMessage(alerts);
 * yield* cancel({ scheduled_message_id: "Q1298393284" });
 * ```
 *
 * @binding
 * @product Message
 */
export interface DeleteScheduledMessage extends Binding.Service<
  DeleteScheduledMessage,
  "Slack.DeleteScheduledMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: DeleteScheduledMessageRequest,
    ) => Effect.Effect<
      Chat.DeleteScheduledMessageResponse,
      Chat.DeleteScheduledMessageError,
      RuntimeContext
    >
  >
> {}

export const DeleteScheduledMessage = Binding.Service<DeleteScheduledMessage>(
  "Slack.DeleteScheduledMessage",
);
