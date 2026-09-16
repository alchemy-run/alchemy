import * as Layer from "effect/Layer";
import * as BindingHttp from "./BindingHttp.ts";
import { SearchIssues, type SearchIssuesRequest } from "./SearchIssues.ts";

export const searchIssuesOperation = BindingHttp.operation(
  "search.issuesAndPullRequests",
  // repo scope is injected into the query, not the parameters
  (octokit, repo) => (request: SearchIssuesRequest) =>
    octokit.rest.search.issuesAndPullRequests({
      ...request,
      q: `repo:${repo.owner}/${repo.repository} ${request.q}`,
    }),
);

/**
 * Token-backed {@link SearchIssues}: captures the provider credential
 * as a `GitHub.PersonalAccessToken` resource bound into the host.
 */
export const SearchIssuesHttp = Layer.effect(
  SearchIssues,
  BindingHttp.make(searchIssuesOperation),
);
