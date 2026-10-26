import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { SearchIssues, type SearchIssuesRequest } from "./SearchIssues.ts";

export const searchIssuesOperation = BindingHttp.operation(
  "search.issuesAndPullRequests",
  (octokit, repo) => (request: SearchIssuesRequest) =>
    octokit.rest.search.issuesAndPullRequests({
      ...request,
      q: `repo:${repo.owner}/${repo.repository} ${request.q}`,
    }),
);

/**
 * Token-backed implementation of {@link SearchIssues}. Provide it on a Worker or
 * Function: it captures a `GitHub.PersonalAccessToken` for the host and binds
 * the token and the repository into it.
 *
 * @layer
 * @product Issue
 * @provides GitHub.SearchIssues
 */
export const SearchIssuesHttp = Layer.effect(SearchIssues, BindingHttp.make(searchIssuesOperation));
