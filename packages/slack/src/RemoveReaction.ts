import type * as Reactions from "@distilled.cloud/slack/reactions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type RemoveReactionRequest = Omit<Reactions.RemoveReactionRequest, "channel">;

/**
 * Remove the bot's emoji reaction from a message in the bound channel (`reactions.remove`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.RemoveReactionHttp` on the Worker or Function.
 *
 * Needs the bot scope `reactions:write`.
 *
 * ### Calling it at runtime
 * **Example:** Remove the bot's emoji reaction from a message in the bound channel
 * ```typescript
 * const unreact = yield* Slack.RemoveReaction(alerts);
 * yield* unreact({ timestamp: sent.ts, name: "white_check_mark" });
 * ```
 *
 * @binding
 * @product Reaction
 */
export interface RemoveReaction extends Binding.Service<
  RemoveReaction,
  "Slack.RemoveReaction",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: RemoveReactionRequest,
    ) => Effect.Effect<
      Reactions.RemoveReactionResponse,
      Reactions.RemoveReactionError,
      RuntimeContext
    >
  >
> {}

export const RemoveReaction = Binding.Service<RemoveReaction>("Slack.RemoveReaction");
