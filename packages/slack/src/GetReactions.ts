import type * as Reactions from "@distilled.cloud/slack/reactions";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Channel } from "./Channel.ts";

export type GetReactionsRequest = Omit<Reactions.GetReactionRequest, "channel">;

/**
 * Read the reactions on a message in the bound channel (`reactions.get`). Bind it to a {@link Channel}; every call targets that channel.
 *
 * Calls run as the host's bot (see {@link BotToken}). Provide
 * `Slack.GetReactionsHttp` on the Worker or Function.
 *
 * Needs the bot scope `reactions:read`.
 *
 * ### Calling it at runtime
 * **Example:** Read the reactions on a message in the bound channel
 * ```typescript
 * const reactions = yield* Slack.GetReactions(alerts);
 * const { message } = yield* reactions({ timestamp: sent.ts });
 * ```
 *
 * @binding
 * @product Reaction
 */
export interface GetReactions extends Binding.Service<
  GetReactions,
  "Slack.GetReactions",
  (
    channel: Channel,
  ) => Effect.Effect<
    (
      request: GetReactionsRequest,
    ) => Effect.Effect<Reactions.GetReactionResponse, Reactions.GetReactionError, RuntimeContext>
  >
> {}

export const GetReactions = Binding.Service<GetReactions>("Slack.GetReactions");
