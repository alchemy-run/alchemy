import { QueuedMessage } from "@alchemy.run/ai/Session";
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";
import { ActivityRecorded, RecordActivity, Status } from "./RecordActivity.command.ts";

const sameQueue = (a: ReadonlyArray<QueuedMessage>, b: ReadonlyArray<QueuedMessage>) =>
  a.length === b.length && a.every((message, index) => message.id === b[index]!.id);

/**
 * The session that looks after one issue, as the board knows it: what the
 * session's object has recorded of it so far.
 */
export class IssueSession extends Domain.Aggregate("IssueSession", {
  id: IssueId,
  state: Schema.Struct({
    /** The last item recorded. */
    seq: Schema.Number,
    status: Status,
    queued: Schema.Array(QueuedMessage),
  }),
  initial: { seq: 0, status: "idle", queued: [] },
  commands: [RecordActivity],
  keyOf: (command) => command.issueId,
  decide: {
    // Items already recorded are dropped, so a batch sent again changes nothing.
    RecordActivity: (session, command) => {
      const items = command.items.filter((entry) => entry.seq > session.seq);
      const changed =
        command.status !== session.status || !sameQueue(command.queued, session.queued);
      return items.length === 0 && !changed
        ? []
        : [new ActivityRecorded({ status: command.status, queued: command.queued, items })];
    },
  },
  evolve: {
    ActivityRecorded: (session, event) => ({
      seq: event.items.at(-1)?.seq ?? session.seq,
      status: event.status,
      queued: event.queued,
    }),
  },
}) {}
