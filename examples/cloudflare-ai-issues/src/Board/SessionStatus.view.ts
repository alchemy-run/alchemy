import { QueuedMessage } from "@alchemy.run/ai/Session";
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueSession } from "./IssueSession.aggregate.ts";
import { Status } from "./RecordActivity.command.ts";

/** Whether the issue's session is working, and what is queued for it. */
export class SessionStatus extends Domain.View("SessionStatus", {
  from: [IssueSession],
  key: IssueSession,
  state: Schema.Struct({ status: Status, queued: Schema.Array(QueuedMessage) }),
  initial: { status: "idle", queued: [] },
  evolve: {
    ActivityRecorded: (_, event) => ({ status: event.status, queued: event.queued }),
  },
}) {}
