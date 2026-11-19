import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ThreadId } from "../Thread/Thread.id.ts";

export class DependencyDone extends Domain.Event(
  "DependencyDone",
  { dependency: ThreadId, waitingOn: Schema.Array(ThreadId) },
  {
    description:
      "A task this one depends on is done. `waitingOn` is what it still waits for; when empty, it is ready.",
  },
) {}

/**
 * Tell a blocked task that one of its dependencies is done. Sent by
 * `Dependencies`; never rejects, and records nothing twice.
 */
export class MarkDependencyDone extends Domain.Command("MarkDependencyDone", {
  input: { threadId: ThreadId, dependency: ThreadId },
  events: [DependencyDone],
}) {}
