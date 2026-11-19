import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { TaskStatus } from "../Task/TaskStatus.ts";
import { Thread } from "./Thread.aggregate.ts";

const claimed = <V>(v: V, e: { by: ActorName; claim: string; leaseUntil: number }): V => ({
  ...v,
  task: { _tag: "Claimed" as const, by: e.by, claim: e.claim, leaseUntil: e.leaseUntil },
});

/**
 * One thread at a glance: its channel, title, labels, task status and how
 * many replies it has. It declares no events, so it emits every event it
 * applies, each with the summary after it: `ChannelBoard` is built from them.
 */
export class ThreadSummary extends Domain.View(
  "ThreadSummary",
  {
    from: [Thread],
    key: Thread,
    middleware: [Session],
    state: Schema.Struct({
      channel: Schema.NullOr(ChannelId),
      title: Schema.String,
      author: Schema.NullOr(ActorName),
      labels: Labels,
      task: Schema.NullOr(TaskStatus),
      replies: Schema.Int,
    }),
    initial: { channel: null, title: "", author: null, labels: [], task: null, replies: 0 },
    evolve: {
      ThreadStarted: (v, e) => ({
        ...v,
        channel: e.channel,
        title: e.title,
        author: e.author,
        labels: e.labels,
      }),
      TaskCreated: (v, e) => ({
        ...v,
        channel: e.channel,
        title: e.title,
        author: e.author,
        labels: e.labels,
        task:
          e.waitingOn.length > 0
            ? { _tag: "Blocked" as const, waitingOn: e.waitingOn }
            : { _tag: "Ready" as const },
      }),
      MessagePosted: (v) => ({ ...v, replies: v.replies + 1 }),
      FollowUpDelivered: (v) => ({ ...v, replies: v.replies + 1 }),
      ThreadLabeled: (v, e) => ({ ...v, labels: e.labels }),
      TaskClaimed: claimed,
      LeaseRenewed: claimed,
      TaskCompleted: (v, e) => ({ ...v, task: { _tag: "Done" as const, by: e.by } }),
      TaskReleased: (v) => ({ ...v, task: { _tag: "Ready" as const } }),
      LeaseExpired: (v) => ({ ...v, task: { _tag: "Ready" as const } }),
      DependencyDone: (v, e) => ({
        ...v,
        task:
          e.waitingOn.length > 0
            ? { _tag: "Blocked" as const, waitingOn: e.waitingOn }
            : { _tag: "Ready" as const },
      }),
    },
  },
  { description: "One thread at a glance: channel, title, labels, task status and reply count." },
) {}

/** Everyone signed in to the board may read every thread. */
export const ThreadSummaryLive = ThreadSummary.toLayer(Effect.succeed(() => Effect.void));
