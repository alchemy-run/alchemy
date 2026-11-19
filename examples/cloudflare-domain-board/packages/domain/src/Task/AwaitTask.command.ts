import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ThreadId } from "../Thread/Thread.id.ts";

export class DependentRegistered extends Domain.Event(
  "DependentRegistered",
  { dependent: ThreadId, done: Schema.Boolean },
  {
    description:
      "A task asked to be told when this one is done. `done` says it already is, so it is told at once.",
  },
) {}

/**
 * Tell this task that `dependent` waits for it. Sent by `Dependencies` when a
 * task that depends on it is created; the task may not exist yet. Never
 * rejects.
 */
export class AwaitTask extends Domain.Command("AwaitTask", {
  input: { threadId: ThreadId, dependent: ThreadId },
  events: [DependentRegistered],
}) {}
