import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { TaskStatus } from "../Task/TaskStatus.ts";
import { ThreadId } from "../Thread/Thread.id.ts";
import { ThreadSummary } from "../Thread/ThreadSummary.view.ts";
import { ChannelId } from "./Channel.id.ts";

/** A thread as its channel lists it. */
export const Card = Schema.Struct({
  title: Schema.String,
  author: Schema.NullOr(ActorName),
  labels: Labels,
  task: Schema.NullOr(TaskStatus),
  replies: Schema.Int,
});
export type Card = typeof Card.Type;

/**
 * Every thread in a channel, with its task status: the channel's backlog.
 * Built from each thread's summary, so it changes whenever a thread does.
 */
export class ChannelBoard extends Domain.View(
  "ChannelBoard",
  {
    from: [ThreadSummary],
    key: ChannelId,
    keyOf: { ThreadSummary: ({ state }) => state?.channel ?? undefined },
    middleware: [Session],
    state: Schema.Struct({ threads: Schema.Record(ThreadId, Card) }),
    initial: { threads: {} },
    evolve: {
      ThreadSummary: (board, _, { source, state }) =>
        state === null || state === undefined
          ? board
          : {
              threads: {
                ...board.threads,
                [source.id]: {
                  title: state.title,
                  author: state.author,
                  labels: state.labels,
                  task: state.task,
                  replies: state.replies,
                },
              },
            },
    },
  },
  { description: "Every thread in a channel, with its task status: the channel's backlog." },
) {}

/** Everyone signed in to the board may read every channel. */
export const ChannelBoardLive = ChannelBoard.toLayer(Effect.succeed(() => Effect.void));
