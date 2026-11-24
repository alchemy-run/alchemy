import { IssueId } from "../../src/Board/Issue.id.ts";

/**
 * Which issue a URL shows, and the URL that shows it. A URL that names none
 * is given a new one, so that a refresh, or the link sent to someone else,
 * opens the same issue.
 */
export const issueOf = (
  url: string,
  fresh: () => string,
): { readonly issueId: IssueId; readonly url: string } => {
  const parsed = new URL(url);
  const named = parsed.searchParams.get("issue");
  const issueId = IssueId.make(named === null || named === "" ? fresh() : named);
  parsed.searchParams.set("issue", issueId);
  return { issueId, url: parsed.toString() };
};
