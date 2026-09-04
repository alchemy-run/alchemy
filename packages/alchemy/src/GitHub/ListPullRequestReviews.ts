import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListPullRequestReviewsRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["listReviews"]["parameters"]
> {}

export type ListPullRequestReviewsResponse =
  RestEndpointMethodTypes["pulls"]["listReviews"]["response"]["data"];

/**
 * List a pull request's reviews (`pulls.listReviews`) — e.g. to gate a
 * merge on an APPROVED review.
 * **Example:** Example
 * ```typescript
 * const listReviews = yield* GitHub.ListPullRequestReviews(repo);
 * const reviews = yield* listReviews({ pull_number: 9 });
 * const approved = reviews.some((review) => review.state === "APPROVED");
 * ```
 *
 * @binding
 */
export interface ListPullRequestReviews extends Binding.Service<
  ListPullRequestReviews,
  "GitHub.ListPullRequestReviews",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: ListPullRequestReviewsRequest,
    ) => Effect.Effect<ListPullRequestReviewsResponse, GitHubApiError>
  >
> {}

export const ListPullRequestReviews = Binding.Service<ListPullRequestReviews>(
  "GitHub.ListPullRequestReviews",
);
