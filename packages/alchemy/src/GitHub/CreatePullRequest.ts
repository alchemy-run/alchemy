import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface CreatePullRequestRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["create"]["parameters"]
> {}

export type CreatePullRequestResponse =
  RestEndpointMethodTypes["pulls"]["create"]["response"]["data"];

/**
 * Open a pull request (`pulls.create`). The RAW operation — branch
 * plumbing (commit, push) is the caller's business, layered on top.
 * @binding
 * @example
 * ```typescript
 * const createPullRequest = yield* GitHub.CreatePullRequest(repo);
 * const pr = yield* createPullRequest({
 *   title: "fix: typo in README",
 *   head: "factory/issue-7",
 *   base: "main",
 *   body: "Closes #7.",
 * });
 * ```
 */
export interface CreatePullRequest extends Binding.Service<
  CreatePullRequest,
  "GitHub.CreatePullRequest",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: CreatePullRequestRequest,
    ) => Effect.Effect<CreatePullRequestResponse, GitHubApiError>
  >
> {}

export const CreatePullRequest = Binding.Service<CreatePullRequest>(
  "GitHub.CreatePullRequest",
);
