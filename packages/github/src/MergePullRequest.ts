import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface MergePullRequestRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["merge"]["parameters"]
> {}

export type MergePullRequestResponse =
  RestEndpointMethodTypes["pulls"]["merge"]["response"]["data"];

/**
 * Merge a pull request (`pulls.merge`). Gate it yourself, e.g. on an approval
 * from {@link ListPullRequestReviews}.
 *
 * Provide `GitHub.MergePullRequestHttp` on a Worker or Function, or
 * `GitHub.MergePullRequestLocal` on an Action.
 *
 * ### Merging Pull Requests at Runtime
 * **Example:** Squash-merge an approved pull request
 * ```typescript
 * const listReviews = yield* GitHub.ListPullRequestReviews(yield* Repo);
 * const mergePullRequest = yield* GitHub.MergePullRequest(yield* Repo);
 *
 * const reviews = yield* listReviews({ pull_number: 9 });
 * if (reviews.some((review) => review.state === "APPROVED")) {
 *   yield* mergePullRequest({ pull_number: 9, merge_method: "squash" });
 * }
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface MergePullRequest extends Binding.Service<
  MergePullRequest,
  "GitHub.MergePullRequest",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: MergePullRequestRequest,
    ) => Effect.Effect<MergePullRequestResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const MergePullRequest = Binding.Service<MergePullRequest>("GitHub.MergePullRequest");
