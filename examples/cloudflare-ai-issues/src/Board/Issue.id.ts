import * as Schema from "effect/Schema";

/** An issue's number on GitHub, as text. */
export const IssueId = Schema.String.pipe(Schema.brand("IssueId"));
export type IssueId = typeof IssueId.Type;
