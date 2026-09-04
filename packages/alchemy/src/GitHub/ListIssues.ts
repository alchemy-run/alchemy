import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListIssuesRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["listForRepo"]["parameters"]
> {}

/**
 * NOTE: GitHub's REST issues list includes pull requests — items that
 * are PRs carry a `pull_request` key; filter on it when you want issues
 * only.
 */
export type ListIssuesResponse =
  RestEndpointMethodTypes["issues"]["listForRepo"]["response"]["data"];

/**
 * List a repository's issues (`issues.listForRepo`).
 * **Example:** Example
 * ```typescript
 * const listIssues = yield* GitHub.ListIssues(repo);
 * const open = yield* listIssues({ state: "open", per_page: 100 });
 * ```
 *
 * @binding
 */
export interface ListIssues extends Binding.Service<
  ListIssues,
  "GitHub.ListIssues",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request?: ListIssuesRequest,
    ) => Effect.Effect<ListIssuesResponse, GitHubApiError>
  >
> {}

export const ListIssues = Binding.Service<ListIssues>("GitHub.ListIssues");
