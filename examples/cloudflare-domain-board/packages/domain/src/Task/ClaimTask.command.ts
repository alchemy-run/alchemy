import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "../Thread/NotStarted.rejection.ts";
import { ThreadId } from "../Thread/Thread.id.ts";
import { NotATask } from "./NotATask.rejection.ts";
import { LeaseSeconds, TaskStatus } from "./TaskStatus.ts";

export class TaskClaimed extends Domain.Event(
  "TaskClaimed",
  { by: ActorName, claim: Schema.String, leaseUntil: Schema.Int },
  {
    description:
      "An actor claimed a task until `leaseUntil` (epoch milliseconds). `claim` names this claim.",
  },
) {}

/** The task is blocked or done, so it can't be claimed. */
export class NotReady extends Domain.Rejection(
  "NotReady",
  { status: TaskStatus },
  { httpApiStatus: 409, description: "The task is blocked or done, so it can't be claimed." },
) {}

/** Someone else holds the task's claim, and its lease has not run out. */
export class AlreadyClaimed extends Domain.Rejection(
  "AlreadyClaimed",
  { by: ActorName, leaseUntil: Schema.Int },
  {
    httpApiStatus: 409,
    description: "Someone else holds the task's claim, and its lease has not run out.",
  },
) {}

export class ClaimTask extends Domain.Command(
  "ClaimTask",
  {
    middleware: [Session],
    input: { threadId: ThreadId, leaseSeconds: Schema.optional(LeaseSeconds) },
    events: [TaskClaimed],
    rejects: [NotStarted, NotATask, NotReady, AlreadyClaimed],
    reply: { leaseUntil: Schema.Int },
  },
  {
    description:
      "Claim a ready task, so no one else works on it. The claim lasts leaseSeconds; renew it while you work, or it lapses and the task is ready again. Claiming a task you already hold renews it.",
  },
) {}
