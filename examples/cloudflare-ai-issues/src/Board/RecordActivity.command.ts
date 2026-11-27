import { QueuedMessage, SessionEntry } from "@alchemy.run/ai/Session";
import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";

export const Status = Schema.Literals(["idle", "working"]);

/** What an issue's session did since the last record: where it stands, and the items it stored. */
export class ActivityRecorded extends Domain.Event("ActivityRecorded", {
  status: Status,
  queued: Schema.Array(QueuedMessage),
  items: Schema.Array(SessionEntry),
}) {}

/** Sent by the object that runs the session, with a batch of what the session reported. */
export class RecordActivity extends Domain.Command("RecordActivity", {
  input: {
    issueId: IssueId,
    status: Status,
    queued: Schema.Array(QueuedMessage),
    items: Schema.Array(SessionEntry),
  },
  events: [ActivityRecorded],
  rejects: [],
}) {}
