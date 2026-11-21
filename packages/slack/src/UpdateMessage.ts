import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type UpdateMessageRequest = Omit<Chat.UpdateChatRequest, "channel">;

/**
 * Edit a message the bot posted in the bound channel (`chat.update`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.UpdateMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Edit a message the bot posted in the bound channel
 * ```typescript
 * const update = yield* Slack.UpdateMessage(alerts);
 * yield* update({ ts: sent.ts, text: "Deploy finished (2m 13s)" });
 * ```
 *
 * @binding
 * @product Message
 */
export interface UpdateMessage extends Binding.Service<
  UpdateMessage,
  "Slack.UpdateMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: UpdateMessageRequest,
    ) => Effect.Effect<Chat.UpdateChatResponse, Chat.UpdateChatError, RuntimeContext>
  >
> {}

export const UpdateMessage = Binding.Service<UpdateMessage>("Slack.UpdateMessage");
