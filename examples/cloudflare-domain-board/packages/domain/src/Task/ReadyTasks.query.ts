import * as Domain from "@alchemy.run/domain";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { ChannelBoard } from "../Channel/ChannelBoard.view.ts";
import { hasAll, Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { ThreadId } from "../Thread/Thread.id.ts";

/** A task anyone may claim now. */
export const ReadyTask = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  author: Schema.NullOr(ActorName),
  labels: Labels,
});

/**
 * The tasks in a channel that may be claimed now: ready ones, and claimed
 * ones whose lease ran out. Filter by labels (`kind=bug`) to pick the work
 * an agent is for, then claim one with `ClaimTask`.
 */
export class ReadyTasks extends Domain.Query(
  "ReadyTasks",
  {
    input: {
      channel: ChannelId,
      labels: Schema.optional(
        Schema.Array(Schema.String).annotate({
          description: 'Only tasks with every one of these labels, such as ["kind=bug"]',
        }),
      ),
    },
    success: Schema.Array(ReadyTask),
    waitsFor: [ChannelBoard],
    middleware: [Session],
  },
  {
    description:
      "List the tasks in a channel you can claim now, optionally only those with some labels. Claim one with ClaimTask; another agent may win it first.",
  },
) {}

export const ReadyTasksLive = ReadyTasks.toLayer(
  Effect.gen(function* () {
    const boards = yield* ChannelBoard;
    return Effect.fn(function* ({ channel, labels }) {
      const board = yield* boards.get(channel).pipe(Effect.orDie);
      const now = yield* Clock.currentTimeMillis;
      const threads = Option.match(board, {
        onNone: () => ({}),
        onSome: (b) => b.threads,
      });
      return Object.entries(threads).flatMap(([threadId, card]) => {
        const task = card.task;
        const claimable =
          task?._tag === "Ready" || (task?._tag === "Claimed" && task.leaseUntil <= now);
        return claimable && hasAll(card.labels, labels ?? [])
          ? [
              {
                threadId: ThreadId.make(threadId),
                title: card.title,
                author: card.author,
                labels: card.labels,
              },
            ]
          : [];
      });
    });
  }),
);
