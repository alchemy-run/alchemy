import * as Domain from "@alchemy.run/domain";
import { Story } from "@alchemy.run/domain/Story";
import { describe, expect, it } from "@effect/vitest";
import { ActorName } from "../src/Actor.ts";
import { Board, BoardHandlers } from "../src/Board.model.ts";
import { ChannelId } from "../src/Channel/Channel.id.ts";
import { ChannelBoard } from "../src/Channel/ChannelBoard.view.ts";
import { CurrentActor } from "../src/CurrentActor.context.ts";
import { DependentRegistered } from "../src/Task/AwaitTask.command.ts";
import { AlreadyClaimed, ClaimTask, NotReady, TaskClaimed } from "../src/Task/ClaimTask.command.ts";
import { CompleteTask, TaskCompleted } from "../src/Task/CompleteTask.command.ts";
import { CreateTask, DependsOnItself, TaskCreated } from "../src/Task/CreateTask.command.ts";
import { LeaseExpired } from "../src/Task/ExpireLease.command.ts";
import { DependencyDone } from "../src/Task/MarkDependencyDone.command.ts";
import { NotATask } from "../src/Task/NotATask.rejection.ts";
import { NotYourClaim } from "../src/Task/NotYourClaim.rejection.ts";
import { ReadyTasks } from "../src/Task/ReadyTasks.query.ts";
import { ReleaseTask, TaskReleased } from "../src/Task/ReleaseTask.command.ts";
import { LeaseRenewed, RenewLease } from "../src/Task/RenewLease.command.ts";
import { AlreadyStarted } from "../src/Thread/AlreadyStarted.rejection.ts";
import { FollowUpDelivered } from "../src/Thread/DeliverFollowUp.command.ts";
import { LabelThread, ThreadLabeled } from "../src/Thread/LabelThread.command.ts";
import { NotStarted } from "../src/Thread/NotStarted.rejection.ts";
import { MessagePosted, PostMessage } from "../src/Thread/PostMessage.command.ts";
import { FollowUpScheduled, ScheduleFollowUp } from "../src/Thread/ScheduleFollowUp.command.ts";
import { StartThread, ThreadStarted } from "../src/Thread/StartThread.command.ts";
import { Thread } from "../src/Thread/Thread.aggregate.ts";
import { ThreadSummary } from "../src/Thread/ThreadSummary.view.ts";
import { ThreadTimeline, TimelineEntry } from "../src/Thread/ThreadTimeline.view.ts";

const story = Story.make(Board, { layer: BoardHandlers });

/** Every story's clock starts here. */
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;

const sam = ActorName.make("sam");
const fixer = ActorName.make("fixer");
const reviewer = ActorName.make("reviewer");
const as = (actor: ActorName) => Story.provide(CurrentActor, actor);
/** The tasks ReadyTasks lists, by id. */
const ready =
  (...threads: ReadonlyArray<{ readonly id: string }>) =>
  (rows: ReadonlyArray<{ readonly threadId: string }>) =>
    expect(rows.map((row) => row.threadId)).toEqual(threads.map((thread) => thread.id));

const dev = ChannelId.make("dev");
const t1 = Thread.ref("t-1");
const t2 = Thread.ref("t-2");
const t3 = Thread.ref("t-3");

const bug = {
  channel: dev,
  title: "Checkout 500s",
  text: "POST /checkout fails for EU carts",
  labels: ["kind=bug"],
};
const bugCreated = new TaskCreated({ ...bug, author: sam, waitingOn: [] });

describe("Board", () => {
  it("the model is well defined", () => expect(Domain.verify(Board)).toEqual([]));

  it.effect("a conversation collects replies and labels", () =>
    story(
      as(sam),
      Story.when(
        new StartThread({
          threadId: t1.id,
          channel: dev,
          title: "Deploys",
          text: "Who owns prod?",
        }),
      ),
      Story.then(
        t1,
        new ThreadStarted({
          channel: dev,
          title: "Deploys",
          text: "Who owns prod?",
          labels: [],
          author: sam,
        }),
      ),
      Story.when(new StartThread({ threadId: t1.id, channel: dev, title: "Again", text: "again" })),
      Story.rejected(new AlreadyStarted({ channel: dev })),
      as(fixer),
      Story.when(new PostMessage({ threadId: t1.id, text: "I do" })),
      Story.then(t1, new MessagePosted({ text: "I do", author: fixer })),
      Story.when(new LabelThread({ threadId: t1.id, add: ["team=infra", "kind=q", "team=infra"] })),
      Story.then(t1, new ThreadLabeled({ labels: ["team=infra", "kind=q"], by: fixer })),
      Story.when(new LabelThread({ threadId: t1.id, remove: ["kind=q"] })),
      Story.then(t1, new ThreadLabeled({ labels: ["team=infra"], by: fixer })),
      Story.when(new ClaimTask({ threadId: t1.id })),
      Story.rejected(new NotATask()),
      Story.when(new PostMessage({ threadId: t2.id, text: "hello?" })),
      Story.rejected(new NotStarted()),
      Story.view(ThreadSummary, t1, { channel: dev, replies: 1, labels: ["team=infra"] }),
      Story.emitted(ThreadTimeline, t1, [
        new TimelineEntry({ kind: "started", author: sam, text: "Deploys\n\nWho owns prod?" }),
        new TimelineEntry({ kind: "message", author: fixer, text: "I do" }),
        new TimelineEntry({ kind: "labeled", author: fixer, text: "team=infra kind=q" }),
        new TimelineEntry({ kind: "labeled", author: fixer, text: "team=infra" }),
      ]),
    ),
  );

  it.effect("one agent claims a task; others are refused until it completes", () =>
    story(
      as(sam),
      Story.when(new CreateTask({ threadId: t1.id, ...bug })),
      Story.then(t1, bugCreated),
      as(fixer),
      Story.query(ReadyTasks, { channel: dev, labels: ["kind=bug"] }, [
        { threadId: t1.id, title: "Checkout 500s", author: sam, labels: ["kind=bug"] },
      ]),
      Story.query(ReadyTasks, { channel: dev, labels: ["kind=feature"] }, []),
      Story.when(new ClaimTask({ threadId: t1.id }), { commandId: "claim-1" }),
      Story.then(
        t1,
        new TaskClaimed({ by: fixer, claim: "claim-1", leaseUntil: T0 + 30 * MINUTE }),
      ),
      Story.replied({ leaseUntil: T0 + 30 * MINUTE }),
      Story.query(ReadyTasks, { channel: dev }, []),
      as(reviewer),
      Story.when(new ClaimTask({ threadId: t1.id })),
      Story.rejected(new AlreadyClaimed({ by: fixer, leaseUntil: T0 + 30 * MINUTE })),
      Story.when(new CompleteTask({ threadId: t1.id })),
      Story.rejected(
        new NotYourClaim({
          status: { _tag: "Claimed", by: fixer, claim: "claim-1", leaseUntil: T0 + 30 * MINUTE },
        }),
      ),
      as(fixer),
      Story.advance("10 minutes"),
      Story.when(new RenewLease({ threadId: t1.id, leaseSeconds: 3600 })),
      Story.then(
        t1,
        new LeaseRenewed({ by: fixer, claim: "claim-1", leaseUntil: T0 + 70 * MINUTE }),
      ),
      Story.replied({ leaseUntil: T0 + 70 * MINUTE }),
      // The first lease's end passes: the renewal replaced its deadline.
      Story.advance("25 minutes"),
      Story.then(t1),
      Story.when(new CompleteTask({ threadId: t1.id, note: "Can I get a review? #812" })),
      Story.then(
        t1,
        new TaskCompleted({ by: fixer, note: "Can I get a review? #812", dependents: [] }),
      ),
      Story.when(new CompleteTask({ threadId: t1.id })),
      Story.then(t1),
      Story.when(new ClaimTask({ threadId: t1.id })),
      Story.rejected(new NotReady({ status: { _tag: "Done", by: fixer } })),
      // The lease's deadline fires after completion and records nothing.
      Story.advance("1 hour"),
      Story.then(t1),
      Story.view(ChannelBoard, dev, (board) =>
        expect(board?.threads[t1.id]?.task).toEqual({ _tag: "Done", by: fixer }),
      ),
    ),
  );

  it.effect("a lease that is not renewed lapses, and the task is ready again", () =>
    story(
      Story.given(t1, bugCreated),
      as(fixer),
      Story.when(new ClaimTask({ threadId: t1.id, leaseSeconds: 60 }), { commandId: "claim-1" }),
      Story.then(t1, new TaskClaimed({ by: fixer, claim: "claim-1", leaseUntil: T0 + MINUTE })),
      Story.advance("1 minute"),
      Story.then(t1, new LeaseExpired({ by: fixer, claim: "claim-1" })),
      Story.when(new RenewLease({ threadId: t1.id })),
      Story.rejected(new NotYourClaim({ status: { _tag: "Ready" } })),
      as(reviewer),
      Story.query(ReadyTasks, { channel: dev }, ready(t1)),
      Story.when(new ClaimTask({ threadId: t1.id }), { commandId: "claim-2" }),
      Story.then(
        t1,
        new TaskClaimed({ by: reviewer, claim: "claim-2", leaseUntil: T0 + 31 * MINUTE }),
      ),
      Story.when(new ReleaseTask({ threadId: t1.id, note: "out of my depth" })),
      Story.then(t1, new TaskReleased({ by: reviewer, note: "out of my depth" })),
      Story.advance("30 minutes"),
      Story.then(t1),
    ),
  );

  it.effect("a task waits for its dependencies, created before or after it", () =>
    story(
      as(sam),
      // t-2 (the fix) exists; t-3 (a migration) does not yet.
      Story.when(new CreateTask({ threadId: t2.id, ...bug })),
      Story.then(t2, bugCreated),
      Story.when(
        new CreateTask({
          threadId: t1.id,
          channel: dev,
          title: "Review the fix",
          text: "Review t-2 once t-3 lands",
          labels: ["kind=review"],
          dependsOn: [t2.id, t3.id, t2.id],
        }),
      ),
      Story.then(
        t1,
        new TaskCreated({
          channel: dev,
          title: "Review the fix",
          text: "Review t-2 once t-3 lands",
          labels: ["kind=review"],
          author: sam,
          waitingOn: [t2.id, t3.id],
        }),
      ),
      Story.then(t2, new DependentRegistered({ dependent: t1.id, done: false })),
      Story.then(t3, new DependentRegistered({ dependent: t1.id, done: false })),
      as(reviewer),
      Story.when(new ClaimTask({ threadId: t1.id })),
      Story.rejected(new NotReady({ status: { _tag: "Blocked", waitingOn: [t2.id, t3.id] } })),
      Story.query(ReadyTasks, { channel: dev, labels: ["kind=review"] }, []),
      as(fixer),
      Story.when(new ClaimTask({ threadId: t2.id }), { commandId: "claim-fix" }),
      Story.then(
        t2,
        new TaskClaimed({ by: fixer, claim: "claim-fix", leaseUntil: T0 + 30 * MINUTE }),
      ),
      Story.when(new CompleteTask({ threadId: t2.id })),
      Story.then(t2, new TaskCompleted({ by: fixer, note: null, dependents: [t1.id] })),
      Story.then(t1, new DependencyDone({ dependency: t2.id, waitingOn: [t3.id] })),
      // The migration is created after the review that waits for it.
      as(sam),
      Story.when(
        new CreateTask({ threadId: t3.id, channel: dev, title: "Migrate", text: "Run it" }),
      ),
      Story.then(
        t3,
        new TaskCreated({
          channel: dev,
          title: "Migrate",
          text: "Run it",
          labels: [],
          author: sam,
          waitingOn: [],
        }),
      ),
      as(fixer),
      Story.when(new ClaimTask({ threadId: t3.id }), { commandId: "claim-migrate" }),
      Story.then(
        t3,
        new TaskClaimed({ by: fixer, claim: "claim-migrate", leaseUntil: T0 + 30 * MINUTE }),
      ),
      Story.when(new CompleteTask({ threadId: t3.id })),
      Story.then(t3, new TaskCompleted({ by: fixer, note: null, dependents: [t1.id] })),
      Story.then(t1, new DependencyDone({ dependency: t3.id, waitingOn: [] })),
      as(reviewer),
      Story.query(ReadyTasks, { channel: dev, labels: ["kind=review"] }, ready(t1)),
      Story.emitted(ThreadTimeline, t1, (entries) =>
        expect(entries.at(-1)?.event).toEqual(
          new TimelineEntry({
            kind: "ready",
            author: ActorName.make("board"),
            text: "t-3 is done",
          }),
        ),
      ),
    ),
  );

  it.effect("a dependency that is already done unblocks its dependent at once", () =>
    story(
      Story.given(
        t2,
        bugCreated,
        new TaskClaimed({ by: fixer, claim: "c", leaseUntil: T0 + MINUTE }),
        new TaskCompleted({ by: fixer, note: null, dependents: [] }),
      ),
      as(sam),
      Story.when(new CreateTask({ threadId: t1.id, ...bug, title: "Review", dependsOn: [t2.id] })),
      Story.then(
        t1,
        new TaskCreated({ ...bug, title: "Review", author: sam, waitingOn: [t2.id] }),
        new DependencyDone({ dependency: t2.id, waitingOn: [] }),
      ),
      Story.then(t2, new DependentRegistered({ dependent: t1.id, done: true })),
      Story.when(new CreateTask({ threadId: t3.id, ...bug, dependsOn: [t3.id] })),
      Story.rejected(new DependsOnItself()),
    ),
  );

  it.effect("a follow-up is posted in its thread when it is due", () =>
    story(
      Story.given(t1, bugCreated),
      as(fixer),
      Story.when(
        new ScheduleFollowUp({ threadId: t1.id, text: "Check CI on #812", inSeconds: 300 }),
        { commandId: "f-1" },
      ),
      Story.then(
        t1,
        new FollowUpScheduled({
          followUpId: "f-1",
          text: "Check CI on #812",
          at: T0 + 5 * MINUTE,
          by: fixer,
        }),
      ),
      Story.replied({ followUpId: "f-1", at: T0 + 5 * MINUTE }),
      Story.advance("4 minutes"),
      Story.then(t1),
      Story.advance("1 minute"),
      Story.then(
        t1,
        new FollowUpDelivered({ followUpId: "f-1", text: "Check CI on #812", by: fixer }),
      ),
      Story.view(ThreadSummary, t1, { replies: 1 }),
    ),
  );
});
