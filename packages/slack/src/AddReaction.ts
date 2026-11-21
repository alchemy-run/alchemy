import type * as Reactions from "@distilled.cloud/slack/reactions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type AddReactionRequest = Omit<Reactions.AddReactionRequest, "channel">;

/**
 * Add an emoji reaction to a message in the bound channel (`reactions.add`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.AddReactionHttp` on the Worker or Function.
 *
 * Needs the bot scope `reactions:write`.
 *
 * ### Calling it at runtime
 * **Example:** Add an emoji reaction to a message in the bound channel
 * ```typescript
 * const react = yield* Slack.AddReaction(alerts);
 * yield* react({ timestamp: sent.ts, name: "white_check_mark" });
 * ```
 *
 * @binding
 * @product Reaction
 */
export interface AddReaction extends Binding.Service<
  AddReaction,
  "Slack.AddReaction",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: AddReactionRequest,
    ) => Effect.Effect<Reactions.AddReactionResponse, Reactions.AddReactionError, RuntimeContext>
  >
> {}

export const AddReaction = Binding.Service<AddReaction>("Slack.AddReaction");
