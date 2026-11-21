import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Labels } from "../Labels.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "./NotStarted.rejection.ts";
import { ThreadId } from "./Thread.id.ts";

export class ThreadLabeled extends Domain.Event(
  "ThreadLabeled",
  { labels: Labels, by: ActorName },
  { description: "A thread's labels changed. `labels` is the whole set after the change." },
) {}

export class LabelThread extends Domain.Command(
  "LabelThread",
  {
    middleware: [Session],
    input: {
      threadId: ThreadId,
      add: Schema.optional(Labels),
      remove: Schema.optional(Labels),
    },
    events: [ThreadLabeled],
    rejects: [NotStarted],
  },
  {
    description:
      'Add and remove labels on a thread, such as add ["pr=812","status=in-review"] and remove ["status=open"].',
  },
) {}
