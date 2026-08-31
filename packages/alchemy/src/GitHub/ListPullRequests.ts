import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListPullRequestsRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["list"]["parameters"]
> {}

export type ListPullRequestsResponse =
  RestEndpointMethodTypes["pulls"]["list"]["response"]["data"];

/**
 * List a repository's pull requests (`pulls.list`).
 * **Example:** Example
 * ```typescript
 * const listPullRequests = yield* GitHub.ListPullRequests(repo);
 * const open = yield* listPullRequests({ state: "open", per_page: 100 });
 * ```
 *
 * @binding
 */
export interface ListPullRequests extends Binding.Service<
  ListPullRequests,
  "GitHub.ListPullRequests",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request?: ListPullRequestsRequest,
    ) => Effect.Effect<ListPullRequestsResponse, GitHubApiError>
  >
> {}

export const ListPullRequests = Binding.Service<ListPullRequests>(
  "GitHub.ListPullRequests",
);
