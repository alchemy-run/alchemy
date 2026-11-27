import { QueuedMessage, SessionEntry } from "@alchemy.run/ai/Session";
import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";

const Status = Schema.Literals(["idle", "working"]);

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

const sameQueue = (a: ReadonlyArray<QueuedMessage>, b: ReadonlyArray<QueuedMessage>) =>
  a.length === b.length && a.every((message, index) => message.id === b[index]!.id);

/** The session that looks after one issue, as the board knows it. */
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

/** One item of the transcript: a message, a tool call or a tool result. */
export class ItemStored extends Domain.Event("ItemStored", SessionEntry.fields) {}

/** The session's transcript, one entry per item. */
export class Transcript extends Domain.Stream("Transcript", {
  key: IssueSession,
  entries: [ItemStored],
}) {}

export class Transcripts extends Domain.Projection("Transcripts", {
  from: [IssueSession],
  key: IssueSession,
  on: [ActivityRecorded],
  writes: [Transcript],
}) {}

export const TranscriptsLive = Transcripts.toLayer(
  Effect.gen(function* () {
    const transcript = yield* Transcript;
    return Effect.fn(function* (batch) {
      for (const input of batch) {
        yield* transcript.append(input, ...input.event.items.map((entry) => new ItemStored(entry)));
      }
    });
  }),
);
