import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type PostMessageRequest = Omit<Chat.PostMessageRequest, "channel">;

/**
 * Post a message to the bound channel (`chat.postMessage`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.PostMessageHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Post a message to the bound channel
 * ```typescript
 * const post = yield* Slack.PostMessage(alerts);
 * const sent = yield* post({ text: "Deploy finished :rocket:" });
 * ```
 *
 * @binding
 * @product Message
 */
export interface PostMessage extends Binding.Service<
  PostMessage,
  "Slack.PostMessage",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: PostMessageRequest,
    ) => Effect.Effect<Chat.PostMessageResponse, Chat.PostMessageError, RuntimeContext>
  >
> {}

export const PostMessage = Binding.Service<PostMessage>("Slack.PostMessage");
