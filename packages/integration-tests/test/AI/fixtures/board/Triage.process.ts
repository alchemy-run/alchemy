import * as AI from "@alchemy.run/ai";
import * as Schema from "effect/Schema";

export const IssueId = Schema.String.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;

/** The issue a session works on. */
export const issue = AI.Input("issue", IssueId);

/** Labels one issue of the board. The board knows it only by this tag. */
export class Triage extends AI.Process<Triage>()("Triage", { inputs: [issue] }) {}
