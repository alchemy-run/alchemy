import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { CurrentActor } from "../CurrentActor.context.ts";
import { Labels } from "../Labels.ts";
import { AwaitTask, DependentRegistered } from "../Task/AwaitTask.command.ts";
import { AlreadyClaimed, ClaimTask, NotReady, TaskClaimed } from "../Task/ClaimTask.command.ts";
import { CompleteTask, TaskCompleted } from "../Task/CompleteTask.command.ts";
import { CreateTask, DependsOnItself, TaskCreated } from "../Task/CreateTask.command.ts";
import { ExpireLease, LeaseExpired } from "../Task/ExpireLease.command.ts";
import { DependencyDone, MarkDependencyDone } from "../Task/MarkDependencyDone.command.ts";
import { NotATask } from "../Task/NotATask.rejection.ts";
import { NotYourClaim } from "../Task/NotYourClaim.rejection.ts";
import { ReleaseTask, TaskReleased } from "../Task/ReleaseTask.command.ts";
import { LeaseRenewed, RenewLease } from "../Task/RenewLease.command.ts";
import { DEFAULT_LEASE_SECONDS, TaskStatus } from "../Task/TaskStatus.ts";
import { AlreadyStarted } from "./AlreadyStarted.rejection.ts";
import { DeliverFollowUp, FollowUpDelivered } from "./DeliverFollowUp.command.ts";
import { LabelThread, ThreadLabeled } from "./LabelThread.command.ts";
import { NotStarted } from "./NotStarted.rejection.ts";
import { MessagePosted, PostMessage } from "./PostMessage.command.ts";
import { FollowUpScheduled, ScheduleFollowUp } from "./ScheduleFollowUp.command.ts";
import { StartThread, ThreadStarted } from "./StartThread.command.ts";
import { ThreadId } from "./Thread.id.ts";

export const ThreadState = Schema.Union([
  // A task that others depend on may be told so before it is created.
  Schema.TaggedStruct("Unstarted", { dependents: Schema.Array(ThreadId) }),
  Schema.TaggedStruct("Open", {
    channel: ChannelId,
    title: Schema.String,
    labels: Labels,
    author: ActorName,
    /** `null` for a conversation; a task's status otherwise. */
    task: Schema.NullOr(TaskStatus),
    /** The tasks that wait for this one. */
    dependents: Schema.Array(ThreadId),
  }),
]);
export type ThreadState = typeof ThreadState.Type;
type Open = Extract<ThreadState, { _tag: "Open" }>;

/** The started thread, or the rejection. Every command on a thread starts from it. */
const started = (thread: ThreadState): Open | NotStarted =>
  thread._tag === "Open" ? thread : new NotStarted();

/** The started thread's task, or the rejection. */
const taskOf = (thread: ThreadState): TaskStatus | NotStarted | NotATask => {
  const open = started(thread);
  if (open._tag !== "Open") return open;
  return open.task ?? new NotATask();
};

/** The task's claim, when `actor` holds it. */
const heldBy = (task: TaskStatus, actor: ActorName) =>
  task._tag === "Claimed" && task.by === actor ? task : undefined;

const leaseEnd = (now: DateTime.Utc, seconds: number | undefined) =>
  DateTime.toEpochMillis(now) + (seconds ?? DEFAULT_LEASE_SECONDS) * 1000;

/** Each id once, in order. */
const unique = <A>(items: ReadonlyArray<A>): ReadonlyArray<A> => {
  const seen: Array<A> = [];
  for (const item of items) if (!seen.includes(item)) seen.push(item);
  return seen;
};

/** `labels` without `remove`, then with `add`, each label once. */
const relabel = (labels: Labels, add: Labels, remove: Labels): Labels =>
  unique([...labels.filter((label) => !remove.includes(label)), ...add]);

const withTask = (thread: ThreadState, task: TaskStatus): ThreadState =>
  thread._tag === "Open" ? { ...thread, task } : thread;

/**
 * One thread on the board: a conversation in a channel, which may also be a
 * task. A task is claimed by one actor at a time, under a lease that lapses
 * unless renewed, and waits for the tasks it depends on. Claims, renewals,
 * completions and expiries race on this one instance, so one of them wins.
 */
export class Thread extends Domain.Aggregate(
  "Thread",
  {
    id: ThreadId,
    state: ThreadState,
    initial: { _tag: "Unstarted", dependents: [] },
    commands: [
      StartThread,
      CreateTask,
      PostMessage,
      LabelThread,
      ScheduleFollowUp,
      DeliverFollowUp,
      ClaimTask,
      RenewLease,
      CompleteTask,
      ReleaseTask,
      ExpireLease,
      AwaitTask,
      MarkDependencyDone,
    ],
    keyOf: (command) => command.threadId,
    decide: {
      StartThread: Effect.fn(function* (thread, cmd) {
        if (thread._tag === "Open") return yield* new AlreadyStarted({ channel: thread.channel });
        return [
          new ThreadStarted({
            channel: cmd.channel,
            title: cmd.title,
            text: cmd.text,
            labels: unique(cmd.labels ?? []),
            author: yield* CurrentActor,
          }),
        ];
      }),
      CreateTask: Effect.fn(function* (thread, cmd, { id }) {
        if (thread._tag === "Open") return yield* new AlreadyStarted({ channel: thread.channel });
        const dependsOn = cmd.dependsOn ?? [];
        if (dependsOn.includes(id)) return yield* new DependsOnItself();
        return [
          new TaskCreated({
            channel: cmd.channel,
            title: cmd.title,
            text: cmd.text,
            labels: unique(cmd.labels ?? []),
            author: yield* CurrentActor,
            waitingOn: unique(dependsOn),
          }),
        ];
      }),
      PostMessage: Effect.fn(function* (thread, cmd) {
        const open = started(thread);
        if (open._tag !== "Open") return yield* open;
        return [new MessagePosted({ text: cmd.text, author: yield* CurrentActor })];
      }),
      LabelThread: Effect.fn(function* (thread, cmd) {
        const open = started(thread);
        if (open._tag !== "Open") return yield* open;
        return [
          new ThreadLabeled({
            labels: relabel(open.labels, cmd.add ?? [], cmd.remove ?? []),
            by: yield* CurrentActor,
          }),
        ];
      }),
      ScheduleFollowUp: Effect.fn(function* (thread, cmd, { commandId, now }) {
        const open = started(thread);
        if (open._tag !== "Open") return yield* open;
        return [
          new FollowUpScheduled({
            followUpId: commandId,
            text: cmd.text,
            at: DateTime.toEpochMillis(now) + cmd.inSeconds * 1000,
            by: yield* CurrentActor,
          }),
        ];
      }),
      DeliverFollowUp: (thread, cmd) =>
        thread._tag === "Open"
          ? [new FollowUpDelivered({ followUpId: cmd.followUpId, text: cmd.text, by: cmd.by })]
          : [],
      ClaimTask: Effect.fn(function* (thread, cmd, { commandId, now }) {
        const task = taskOf(thread);
        if (task._tag === "NotStarted" || task._tag === "NotATask") return yield* task;
        const actor = yield* CurrentActor;
        const leaseUntil = leaseEnd(now, cmd.leaseSeconds);
        if (task._tag === "Claimed") {
          // Claiming again renews your own claim.
          if (task.by === actor)
            return [new TaskClaimed({ by: actor, claim: task.claim, leaseUntil })];
          // A lapsed lease no longer holds the task, even before it is expired.
          if (task.leaseUntil > DateTime.toEpochMillis(now)) {
            return yield* new AlreadyClaimed({ by: task.by, leaseUntil: task.leaseUntil });
          }
        } else if (task._tag !== "Ready") {
          return yield* new NotReady({ status: task });
        }
        return [new TaskClaimed({ by: actor, claim: commandId, leaseUntil })];
      }),
      RenewLease: Effect.fn(function* (thread, cmd, { now }) {
        const task = taskOf(thread);
        if (task._tag === "NotStarted" || task._tag === "NotATask") return yield* task;
        const actor = yield* CurrentActor;
        const held = heldBy(task, actor);
        if (held === undefined) return yield* new NotYourClaim({ status: task });
        return [
          new LeaseRenewed({
            by: actor,
            claim: held.claim,
            leaseUntil: leaseEnd(now, cmd.leaseSeconds),
          }),
        ];
      }),
      CompleteTask: Effect.fn(function* (thread, cmd) {
        const task = taskOf(thread);
        if (task._tag === "NotStarted" || task._tag === "NotATask") return yield* task;
        const actor = yield* CurrentActor;
        // Completing a task you already completed changes nothing.
        if (task._tag === "Done" && task.by === actor) return [];
        if (heldBy(task, actor) === undefined) return yield* new NotYourClaim({ status: task });
        return [
          new TaskCompleted({
            by: actor,
            note: cmd.note ?? null,
            dependents: thread._tag === "Open" ? thread.dependents : [],
          }),
        ];
      }),
      ReleaseTask: Effect.fn(function* (thread, cmd) {
        const task = taskOf(thread);
        if (task._tag === "NotStarted" || task._tag === "NotATask") return yield* task;
        const actor = yield* CurrentActor;
        if (heldBy(task, actor) === undefined) return yield* new NotYourClaim({ status: task });
        return [new TaskReleased({ by: actor, note: cmd.note ?? null })];
      }),
      ExpireLease: (thread, cmd, { now }) => {
        const task = thread._tag === "Open" ? thread.task : null;
        return task?._tag === "Claimed" &&
          task.claim === cmd.claim &&
          task.leaseUntil <= DateTime.toEpochMillis(now)
          ? [new LeaseExpired({ by: task.by, claim: task.claim })]
          : [];
      },
      AwaitTask: (thread, cmd) =>
        thread.dependents.includes(cmd.dependent)
          ? []
          : [
              new DependentRegistered({
                dependent: cmd.dependent,
                done: thread._tag === "Open" && thread.task?._tag === "Done",
              }),
            ],
      MarkDependencyDone: (thread, cmd) => {
        const task = thread._tag === "Open" ? thread.task : null;
        return task?._tag === "Blocked" && task.waitingOn.includes(cmd.dependency)
          ? [
              new DependencyDone({
                dependency: cmd.dependency,
                waitingOn: task.waitingOn.filter((dep) => dep !== cmd.dependency),
              }),
            ]
          : [];
      },
    },
    evolve: {
      ThreadStarted: (thread, e) => ({
        _tag: "Open" as const,
        channel: e.channel,
        title: e.title,
        labels: e.labels,
        author: e.author,
        task: null,
        dependents: thread.dependents,
      }),
      TaskCreated: (thread, e) => ({
        _tag: "Open" as const,
        channel: e.channel,
        title: e.title,
        labels: e.labels,
        author: e.author,
        task:
          e.waitingOn.length > 0
            ? { _tag: "Blocked" as const, waitingOn: e.waitingOn }
            : { _tag: "Ready" as const },
        dependents: thread.dependents,
      }),
      MessagePosted: (thread) => thread,
      ThreadLabeled: (thread, e) =>
        thread._tag === "Open" ? { ...thread, labels: e.labels } : thread,
      FollowUpScheduled: (thread) => thread,
      FollowUpDelivered: (thread) => thread,
      TaskClaimed: (thread, e) =>
        withTask(thread, { _tag: "Claimed", by: e.by, claim: e.claim, leaseUntil: e.leaseUntil }),
      LeaseRenewed: (thread, e) =>
        withTask(thread, { _tag: "Claimed", by: e.by, claim: e.claim, leaseUntil: e.leaseUntil }),
      TaskCompleted: (thread, e) => withTask(thread, { _tag: "Done", by: e.by }),
      TaskReleased: (thread) => withTask(thread, { _tag: "Ready" }),
      LeaseExpired: (thread) => withTask(thread, { _tag: "Ready" }),
      DependentRegistered: (thread, e) => ({
        ...thread,
        dependents: [...thread.dependents, e.dependent],
      }),
      DependencyDone: (thread, e) =>
        withTask(
          thread,
          e.waitingOn.length > 0 ? { _tag: "Blocked", waitingOn: e.waitingOn } : { _tag: "Ready" },
        ),
    },
    reply: {
      ClaimTask: (thread) => ({
        leaseUntil:
          thread._tag === "Open" && thread.task?._tag === "Claimed" ? thread.task.leaseUntil : 0,
      }),
      RenewLease: (thread) => ({
        leaseUntil:
          thread._tag === "Open" && thread.task?._tag === "Claimed" ? thread.task.leaseUntil : 0,
      }),
      ScheduleFollowUp: (_, events) => {
        const scheduled = events.find((e) => e._tag === "FollowUpScheduled");
        return scheduled?._tag === "FollowUpScheduled"
          ? { followUpId: scheduled.followUpId, at: scheduled.at }
          : { followUpId: "", at: 0 };
      },
    },
    invariants: {
      /** A blocked task waits for at least one other task. */
      ABlockedTaskWaitsOnSomething: (thread) =>
        thread._tag !== "Open" ||
        thread.task?._tag !== "Blocked" ||
        thread.task.waitingOn.length > 0,
    },
    transitions: {
      /** A done task stays done: nothing claims, releases or expires it again. */
      ADoneTaskStaysDone: ({ before, after }) =>
        before._tag !== "Open" ||
        before.task?._tag !== "Done" ||
        (after._tag === "Open" && after.task?._tag === "Done"),
      /** A conversation never turns into a task, nor a task into a conversation. */
      AThreadKeepsItsKind: ({ before, after }) =>
        before._tag !== "Open" ||
        (after._tag === "Open" && (before.task === null) === (after.task === null)),
    },
  },
  { description: "A thread on the board: a conversation in a channel, which may be a task." },
) {}
