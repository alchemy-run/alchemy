import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";

export class IssueReported extends Domain.Event("IssueReported", {
  title: Schema.String,
  body: Schema.String,
}) {}

/** Someone opened an issue. */
export class ReportIssue extends Domain.Command("ReportIssue", {
  input: { issueId: IssueId, title: Schema.String, body: Schema.String },
  events: [IssueReported],
  rejects: [],
}) {}
