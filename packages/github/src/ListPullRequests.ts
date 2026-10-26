import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface ListPullRequestsRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["list"]["parameters"]
> {}

export type ListPullRequestsResponse = RestEndpointMethodTypes["pulls"]["list"]["response"]["data"];

/**
 * List one page of the repository's pull requests (`pulls.list`).
 *
 * Provide `GitHub.ListPullRequestsHttp` on a Worker or Function, or
 * `GitHub.ListPullRequestsLocal` on an Action.
 *
 * ### Listing Pull Requests at Runtime
 * **Example:** List open pull requests into main
 * ```typescript
 * const listPullRequests = yield* GitHub.ListPullRequests(yield* Repo);
 * const open = yield* listPullRequests({ state: "open", base: "main" });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface ListPullRequests extends Binding.Service<
  ListPullRequests,
  "GitHub.ListPullRequests",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request?: ListPullRequestsRequest,
    ) => Effect.Effect<ListPullRequestsResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const ListPullRequests = Binding.Service<ListPullRequests>("GitHub.ListPullRequests");
