import type * as Chat from "@distilled.cloud/slack/chat";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type GetPermalinkRequest = Omit<Chat.GetPermalinkRequest, "channel">;

/**
 * Get a permanent link to a message in the bound channel (`chat.getPermalink`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetPermalinkHttp` on the Worker or Function.
 *
 * ### Calling it at runtime
 * **Example:** Get a permanent link to a message in the bound channel
 * ```typescript
 * const link = yield* Slack.GetPermalink(alerts);
 * const { permalink } = yield* link({ message_ts: sent.ts });
 * ```
 *
 * @binding
 * @product Message
 */
export interface GetPermalink extends Binding.Service<
  GetPermalink,
  "Slack.GetPermalink",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: GetPermalinkRequest,
    ) => Effect.Effect<Chat.GetPermalinkResponse, Chat.GetPermalinkError, RuntimeContext>
  >
> {}

export const GetPermalink = Binding.Service<GetPermalink>("Slack.GetPermalink");
