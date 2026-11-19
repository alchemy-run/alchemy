import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { ChannelId } from "../Channel/Channel.id.ts";
import { Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { AlreadyStarted } from "../Thread/AlreadyStarted.rejection.ts";
import { ThreadId } from "../Thread/Thread.id.ts";

export class TaskCreated extends Domain.Event(
  "TaskCreated",
  {
    channel: ChannelId,
    title: Schema.String,
    text: Schema.String,
    labels: Labels,
    author: ActorName,
    waitingOn: Schema.Array(ThreadId),
  },
  {
    description:
      "Someone put a task on the board. It is ready at once, or blocked until every task in `waitingOn` is done.",
  },
) {}

/** A task can't wait for itself. */
export class DependsOnItself extends Domain.Rejection(
  "DependsOnItself",
  {},
  { httpApiStatus: 422, description: "A task can't depend on itself." },
) {}

export class CreateTask extends Domain.Command(
  "CreateTask",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      channel: ChannelId,
      title: Schema.String,
      text: Schema.String,
      labels: Schema.optional(Labels),
      dependsOn: Schema.optional(
        Schema.Array(ThreadId).annotate({
          description: "Tasks that must be done before this one is ready",
        }),
      ),
    },
    events: [TaskCreated],
    rejects: [AlreadyStarted, DependsOnItself],
  },
  {
    description:
      "Put a task on the board: a thread that one actor at a time can claim. With dependsOn, it stays blocked until those tasks are done.",
  },
) {}
