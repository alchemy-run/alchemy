import * as S from "effect/Schema";

export type IssueId = number;
export const IssueId = S.Int.pipe(S.positive()).annotations({
  description: "The ID of the issue",
});

export type IssueDescription = string;
export const IssueDescription = S.String.annotations({
  description: "The description of the issue",
});

export type IssueTitle = string;
export const IssueTitle = S.String.annotations({
  description: "The title of the issue",
});

export class Issue extends S.Class<Issue>("Issue")({
  issueId: IssueId,
  title: IssueTitle,
  description: IssueDescription,
}) {}
