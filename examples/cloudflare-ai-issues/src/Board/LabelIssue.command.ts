import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";

export const Label = Schema.Literals(["bug", "feature", "question"]);

export class IssueLabeled extends Domain.Event("IssueLabeled", { label: Label }) {}

export class LabelIssue extends Domain.Command(
  "LabelIssue",
  {
    input: { issueId: IssueId, label: Label },
    events: [IssueLabeled],
    rejects: [],
  },
  { description: "Record what kind of issue this is: a bug, a feature or a question." },
) {}
