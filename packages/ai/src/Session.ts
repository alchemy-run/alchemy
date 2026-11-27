/**
 * What a session says about itself, as Schemas: the shapes that cross the
 * network. The module imports only `effect`, so a browser can bundle it.
 *
 * @module
 */
import * as Schema from "effect/Schema";

/** A message a session has stored and not yet read. */
export const QueuedMessage = Schema.Struct({
  /** What `withdraw` takes. */
  id: Schema.String,
  text: Schema.String,
  /** `steer` joins the turn that is running; `queue` waits for it to end. */
  delivery: Schema.Literals(["queue", "steer"]),
});
/** A message a session has stored and not yet read. */
export type QueuedMessage = typeof QueuedMessage.Type;

/** One thing in a session's transcript. */
export const SessionItem = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    text: Schema.String,
    /** The tools this answer asked for. */
    toolCalls: Schema.Array(
      Schema.Struct({ id: Schema.String, name: Schema.String, input: Schema.Unknown }),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    /** The call this is the result of. */
    callId: Schema.String,
    name: Schema.String,
    output: Schema.String,
    isError: Schema.Boolean,
  }),
]);
/** One thing in a session's transcript. */
export type SessionItem = typeof SessionItem.Type;

/** A transcript item and where it sits. `seq` grows with every item of the session. */
export const SessionEntry = Schema.Struct({ seq: Schema.Number, item: SessionItem });
/** A transcript item and where it sits. `seq` grows with every item of the session. */
export type SessionEntry = typeof SessionEntry.Type;

/** Whether a session is working on a turn. */
export const SessionStatus = Schema.Literals(["idle", "working"]);
/** Whether a session is working on a turn. */
export type SessionStatus = typeof SessionStatus.Type;

/** Where a session stands: whether it is working on a turn, and what is queued for it. */
export const SessionState = Schema.Struct({
  status: SessionStatus,
  queued: Schema.Array(QueuedMessage),
});
/** Where a session stands: whether it is working on a turn, and what is queued for it. */
export type SessionState = typeof SessionState.Type;

/**
 * What a session reports. `status` says whether it is working and what is
 * queued: it is the first event of every `events` stream, and is sent again
 * whenever either changes. `item` is a transcript item, stored and numbered.
 */
export const SessionEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("status"),
    status: SessionStatus,
    queued: Schema.Array(QueuedMessage),
  }),
  Schema.Struct({ type: Schema.Literal("item"), seq: Schema.Number, item: SessionItem }),
]);
/** What a session reports: its status, or one transcript item. */
export type SessionEvent = typeof SessionEvent.Type;

/** Which stored items `history` returns. */
export const HistoryOptions = Schema.Struct({
  /** Only items after this `seq` (before it, when `order` is `"desc"`). */
  after: Schema.optional(Schema.Number),
  /** @default 50 */
  take: Schema.optional(Schema.Number),
  /** @default "asc" */
  order: Schema.optional(Schema.Literals(["asc", "desc"])),
});
/** Which stored items `history` returns. */
export type HistoryOptions = typeof HistoryOptions.Type;

/** A page of a session's items. */
export const SessionPage = Schema.Struct({
  items: Schema.Array(SessionEntry),
  /** The `after` of the next page. Absent on the last one. */
  next: Schema.optional(Schema.Number),
});
/** A page of a session's items. */
export type SessionPage = typeof SessionPage.Type;
