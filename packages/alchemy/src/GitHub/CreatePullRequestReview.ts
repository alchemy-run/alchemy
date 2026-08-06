import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface CreatePullRequestReviewRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["createReview"]["parameters"]
> {}

export type CreatePullRequestReviewResponse =
  RestEndpointMethodTypes["pulls"]["createReview"]["response"]["data"];

/**
 * Submit a pull request REVIEW (`pulls.createReview`): an overall
 * `body` + `event` verdict (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`)
 * with inline `comments` anchored to diff lines — one atomic
 * submission, unlike {@link CreateIssueComment}'s flat thread comment.
 * @binding
 * @example
 * ```typescript
 * const review = yield* GitHub.CreatePullRequestReview(repo);
 * yield* review({
 *   pull_number: 7,
 *   event: "REQUEST_CHANGES",
 *   body: "Two problems, both anchored inline.",
 *   comments: [{ path: "src/x.ts", line: 42, body: "off-by-one" }],
 * });
 * ```
 */
export interface CreatePullRequestReview extends Binding.Service<
  CreatePullRequestReview,
  "GitHub.CreatePullRequestReview",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: CreatePullRequestReviewRequest,
    ) => Effect.Effect<CreatePullRequestReviewResponse, GitHubApiError>
  >
> {}

export const CreatePullRequestReview = Binding.Service<CreatePullRequestReview>(
  "GitHub.CreatePullRequestReview",
);
