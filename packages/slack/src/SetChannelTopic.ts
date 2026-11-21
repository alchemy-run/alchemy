import type * as Conversations from "@distilled.cloud/slack/conversations";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type SetChannelTopicRequest = Omit<Conversations.SetTopicRequest, "channel">;

/**
 * Set the bound channel's topic (`conversations.setTopic`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.SetChannelTopicHttp` on the Worker or Function.
 *
 * Needs one of the bot scopes `channels:write.topic`, `groups:write.topic`, `mpim:write.topic`, `im:write.topic`, `channels:manage`, `groups:write`, `im:write`, `mpim:write`.
 *
 * ### Calling it at runtime
 * **Example:** Set the bound channel's topic
 * ```typescript
 * const setTopic = yield* Slack.SetChannelTopic(alerts);
 * yield* setTopic({ topic: "On call: @alice" });
 * ```
 *
 * @binding
 * @product Channel
 */
export interface SetChannelTopic extends Binding.Service<
  SetChannelTopic,
  "Slack.SetChannelTopic",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: SetChannelTopicRequest,
    ) => Effect.Effect<Conversations.SetTopicResponse, Conversations.SetTopicError, RuntimeContext>
  >
> {}

export const SetChannelTopic = Binding.Service<SetChannelTopic>("Slack.SetChannelTopic");
