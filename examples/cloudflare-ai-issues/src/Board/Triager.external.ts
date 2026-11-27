import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";

/**
 * Whatever looks after issues, as the board asks it: start on an issue, and
 * pass on what was said about it. The board does not know it is a model.
 */
export class Triager extends Domain.ExternalSystem("Triager", {
  start: { args: { issue: IssueId } },
  tell: { args: { issue: IssueId, text: Schema.String, id: Schema.String } },
}) {}
