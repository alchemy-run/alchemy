import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { message } from "../vocabulary.ts";

export class Reply extends AI.Tool<Reply>()("reply")`
Reply with ${message} in the Discord thread you were addressed
from.` {}

/**
 * TODO(discord): the physics is `Discord.CreateMessage`, but "the
 * thread you were addressed from" needs the run's mention (channel
 * id) to reach the handler — run-scoped tool context is the missing
 * kernel seam. Until it lands this fails MODEL-VISIBLY.
 */
export const ReplyLive = Layer.succeed(Reply, ((input: { message: string }) =>
  Effect.fail(
    `reply is not wired yet (run-scoped thread routing is TODO): ` +
      `your drafted reply was: ${JSON.stringify(input.message)}`,
  )) as never);
