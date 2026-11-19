import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "../Thread/NotStarted.rejection.ts";
import { ThreadId } from "../Thread/Thread.id.ts";
import { NotATask } from "./NotATask.rejection.ts";
import { NotYourClaim } from "./NotYourClaim.rejection.ts";

export class TaskReleased extends Domain.Event(
  "TaskReleased",
  { by: ActorName, note: Schema.NullOr(Schema.String) },
  { description: "The claim's holder gave a task back. It is ready again." },
) {}

export class ReleaseTask extends Domain.Command(
  "ReleaseTask",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      note: Schema.optional(Schema.String.annotate({ description: "Why you are giving it back" })),
    },
    events: [TaskReleased],
    rejects: [NotStarted, NotATask, NotYourClaim],
  },
  { description: "Give back a task you hold, so someone else can claim it." },
) {}
