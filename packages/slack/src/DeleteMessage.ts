import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type DeleteMessageRequest = Omit<Chat.DeleteChatRequest, "channel">;

/**
 * Delete a message from the bound channel (`chat.delete`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.DeleteMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Delete a message from the bound channel
 * ```typescript
 * const remove = yield* Slack.DeleteMessage(alerts);
 * yield* remove({ ts: sent.ts });
 * ```
 *
 * @binding
 * @product Message
 */
export interface DeleteMessage extends Binding.Service<
  DeleteMessage,
  "Slack.DeleteMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: DeleteMessageRequest,
    ) => Effect.Effect<Chat.DeleteChatResponse, Chat.DeleteChatError, RuntimeContext>
  >
> {}

export const DeleteMessage = Binding.Service<DeleteMessage>("Slack.DeleteMessage");
