import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "../Thread/NotStarted.rejection.ts";
import { ThreadId } from "../Thread/Thread.id.ts";
import { NotATask } from "./NotATask.rejection.ts";
import { NotYourClaim } from "./NotYourClaim.rejection.ts";

export class TaskCompleted extends Domain.Event(
  "TaskCompleted",
  {
    by: ActorName,
    note: Schema.NullOr(Schema.String),
    dependents: Schema.Array(ThreadId),
  },
  { description: "The claim's holder finished a task. Each of its `dependents` is told." },
) {}

export class CompleteTask extends Domain.Command(
  "CompleteTask",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      note: Schema.optional(
        Schema.String.annotate({ description: "A closing message, such as a review request" }),
      ),
    },
    events: [TaskCompleted],
    rejects: [NotStarted, NotATask, NotYourClaim],
  },
  {
    description:
      "Finish a task you hold, with an optional closing note. Tasks that depend on it become ready once all their dependencies are done.",
  },
) {}
