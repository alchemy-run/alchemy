import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface MergePullRequestRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["merge"]["parameters"]
> {}

export type MergePullRequestResponse =
  RestEndpointMethodTypes["pulls"]["merge"]["response"]["data"];

/**
 * Merge a pull request (`pulls.merge`). The RAW operation — approval
 * gates and merge policies are the caller's business rules, layered on
 * top (e.g. with {@link ListPullRequestReviews}).
 * @binding
 * @example
 * ```typescript
 * const merge = yield* GitHub.MergePullRequest(repo);
 * const merged = yield* merge({ pull_number: 9 });
 * ```
 */
export interface MergePullRequest extends Binding.Service<
  MergePullRequest,
  "GitHub.MergePullRequest",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: MergePullRequestRequest,
    ) => Effect.Effect<MergePullRequestResponse, GitHubApiError>
  >
> {}

export const MergePullRequest = Binding.Service<MergePullRequest>(
  "GitHub.MergePullRequest",
);
