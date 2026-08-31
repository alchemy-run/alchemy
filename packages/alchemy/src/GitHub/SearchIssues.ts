import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

/**
 * `q` is the GitHub search syntax MINUS the repo scope — the binding
 * prefixes `repo:{owner}/{name}` from the bound repository.
 */
export interface SearchIssuesRequest extends EndpointParameters<
  RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["parameters"],
  "q"
> {
  q: string;
}

export type SearchIssuesResponse =
  RestEndpointMethodTypes["search"]["issuesAndPullRequests"]["response"]["data"];

/**
 * Search issues and pull requests scoped to the repository
 * (`search.issuesAndPullRequests` with `repo:` injected).
 * **Example:** Example
 * ```typescript
 * const search = yield* GitHub.SearchIssues(repo);
 * const dupes = yield* search({ q: "polling dedupe in:title", per_page: 20 });
 * ```
 *
 * @binding
 */
export interface SearchIssues extends Binding.Service<
  SearchIssues,
  "GitHub.SearchIssues",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: SearchIssuesRequest,
    ) => Effect.Effect<SearchIssuesResponse, GitHubApiError>
  >
> {}

export const SearchIssues = Binding.Service<SearchIssues>(
  "GitHub.SearchIssues",
);
