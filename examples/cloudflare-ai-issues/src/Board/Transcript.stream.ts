import { SessionEntry } from "@alchemy.run/ai/Session";
import * as Domain from "@alchemy.run/domain";
import { IssueSession } from "./IssueSession.aggregate.ts";

/** One item of the transcript: a message, a tool call or a tool result. */
export class ItemStored extends Domain.Event("ItemStored", SessionEntry.fields) {}

/** The session's transcript, one entry per item. */
export class Transcript extends Domain.Stream("Transcript", {
  key: IssueSession,
  entries: [ItemStored],
}) {}
