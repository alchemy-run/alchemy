import * as Option from "effect/Option";
import { IssueId } from "../../src/Board/Issue.id.ts";

/** The issue an address names with `?issue=`, if it names one. */
export const issueIn = (url: string): Option.Option<IssueId> => {
  const named = new URL(url).searchParams.get("issue");
  return named === null || named === "" ? Option.none() : Option.some(IssueId.make(named));
};

/** The address that opens an issue, or the board with none open. */
export const urlOf = (url: string, issueId: Option.Option<IssueId>): string => {
  const parsed = new URL(url);
  Option.match(issueId, {
    onNone: () => parsed.searchParams.delete("issue"),
    onSome: (id) => parsed.searchParams.set("issue", id),
  });
  return parsed.toString();
};
