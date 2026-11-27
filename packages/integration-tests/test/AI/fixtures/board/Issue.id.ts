import * as Schema from "effect/Schema";

export const IssueId = Schema.String.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;
