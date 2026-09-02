import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListPullRequestReviewCommentsRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["listReviewComments"]["parameters"]
> {}

export type ListPullRequestReviewCommentsResponse =
  RestEndpointMethodTypes["pulls"]["listReviewComments"]["response"]["data"];

/**
 * List a pull request's INLINE review comments
 * (`pulls.listReviewComments`) — the ones anchored to a `path` and
 * `line` of the diff, each carrying its `pull_request_review_id`.
 * **Example:** Example
 * ```typescript
 * const listReviewComments = yield* GitHub.ListPullRequestReviewComments(repo);
 * const inline = yield* listReviewComments({ pull_number: 9, per_page: 100 });
 * ```
 *
 * @binding
 */
export interface ListPullRequestReviewComments extends Binding.Service<
  ListPullRequestReviewComments,
  "GitHub.ListPullRequestReviewComments",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: ListPullRequestReviewCommentsRequest,
    ) => Effect.Effect<ListPullRequestReviewCommentsResponse, GitHubApiError>
  >
> {}

export const ListPullRequestReviewComments =
  Binding.Service<ListPullRequestReviewComments>(
    "GitHub.ListPullRequestReviewComments",
  );
