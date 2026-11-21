import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type ScheduleMessageRequest = Omit<Chat.ScheduleMessageRequest, "channel">;

/**
 * Schedule a message for the bound channel (`chat.scheduleMessage`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.ScheduleMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Schedule a message for the bound channel
 * ```typescript
 * const schedule = yield* Slack.ScheduleMessage(alerts);
 * yield* schedule({ post_at: Math.floor(Date.now() / 1000) + 3600, text: "Standup in 5 minutes" });
 * ```
 *
 * @binding
 * @product Message
 */
export interface ScheduleMessage extends Binding.Service<
  ScheduleMessage,
  "Slack.ScheduleMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: ScheduleMessageRequest,
    ) => Effect.Effect<Chat.ScheduleMessageResponse, Chat.ScheduleMessageError, RuntimeContext>
  >
> {}

export const ScheduleMessage = Binding.Service<ScheduleMessage>("Slack.ScheduleMessage");
