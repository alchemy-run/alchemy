import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { Session } from "../Session.middleware.ts";
import { Thread } from "./Thread.aggregate.ts";

/** One line of a thread's conversation: a message, or what happened to its task. */
export class TimelineEntry extends Domain.Event(
  "TimelineEntry",
  {
    kind: Schema.Literals([
      "started",
      "message",
      "follow-up",
      "labeled",
      "claimed",
      "renewed",
      "released",
      "expired",
      "ready",
      "completed",
    ]),
    author: ActorName,
    text: Schema.String,
  },
  { description: "One line of a thread: a message, or what happened to its task." },
) {}

const board = ActorName.make("board");

/**
 * A thread's conversation, oldest first: every message, follow-up and change
 * to its task, as one line each. Read it with `list`, or follow it with
 * `events` to be woken by each reply.
 */
export class ThreadTimeline extends Domain.View(
  "ThreadTimeline",
  {
    from: [Thread],
    key: Thread,
    middleware: [Session],
    state: Schema.Struct({ channel: Schema.NullOr(ChannelId) }),
    initial: { channel: null },
    evolve: {
      ThreadStarted: (_, e) => ({ channel: e.channel }),
      TaskCreated: (_, e) => ({ channel: e.channel }),
    },
    events: [TimelineEntry],
    emit: {
      ThreadStarted: (e) =>
        new TimelineEntry({ kind: "started", author: e.author, text: `${e.title}\n\n${e.text}` }),
      TaskCreated: (e) =>
        new TimelineEntry({ kind: "started", author: e.author, text: `${e.title}\n\n${e.text}` }),
      MessagePosted: (e) => new TimelineEntry({ kind: "message", author: e.author, text: e.text }),
      FollowUpDelivered: (e) =>
        new TimelineEntry({ kind: "follow-up", author: e.by, text: e.text }),
      ThreadLabeled: (e) =>
        new TimelineEntry({
          kind: "labeled",
          author: e.by,
          text: e.labels.join(" "),
        }),
      TaskClaimed: (e) =>
        new TimelineEntry({
          kind: "claimed",
          author: e.by,
          text: `until ${new Date(e.leaseUntil).toISOString()}`,
        }),
      LeaseRenewed: (e) =>
        new TimelineEntry({
          kind: "renewed",
          author: e.by,
          text: `until ${new Date(e.leaseUntil).toISOString()}`,
        }),
      TaskReleased: (e) =>
        new TimelineEntry({ kind: "released", author: e.by, text: e.note ?? "" }),
      LeaseExpired: (e) =>
        new TimelineEntry({ kind: "expired", author: board, text: `${e.by}'s lease ran out` }),
      DependencyDone: (e) =>
        e.waitingOn.length === 0
          ? new TimelineEntry({ kind: "ready", author: board, text: `${e.dependency} is done` })
          : undefined,
      TaskCompleted: (e) =>
        new TimelineEntry({ kind: "completed", author: e.by, text: e.note ?? "" }),
    },
  },
  { description: "A thread's conversation, oldest first: messages, follow-ups and task changes." },
) {}

/** Everyone signed in to the board may read every thread. */
export const ThreadTimelineLive = ThreadTimeline.toLayer(Effect.succeed(() => Effect.void));
