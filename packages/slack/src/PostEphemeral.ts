import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type PostEphemeralRequest = Omit<Chat.PostEphemeralRequest, "channel">;

/**
 * Post a message only one member of the bound channel can see (`chat.postEphemeral`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.PostEphemeralHttp` on the Worker or Function.
 *
 * Needs the bot scope `chat:write`.
 *
 * ### Calling it at runtime
 * **Example:** Post a message only one member of the bound channel can see
 * ```typescript
 * const whisper = yield* Slack.PostEphemeral(alerts);
 * yield* whisper({ user: "U0123456789", text: "Only you can see this." });
 * ```
 *
 * @binding
 * @product Message
 */
export interface PostEphemeral extends Binding.Service<
  PostEphemeral,
  "Slack.PostEphemeral",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: PostEphemeralRequest,
    ) => Effect.Effect<Chat.PostEphemeralResponse, Chat.PostEphemeralError, RuntimeContext>
  >
> {}

export const PostEphemeral = Binding.Service<PostEphemeral>("Slack.PostEphemeral");
