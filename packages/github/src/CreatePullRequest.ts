import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface CreatePullRequestRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["create"]["parameters"]
> {}

export type CreatePullRequestResponse =
  RestEndpointMethodTypes["pulls"]["create"]["response"]["data"];

/**
 * Open a pull request (`pulls.create`). The `head` branch must already exist;
 * pushing commits to it is up to the caller.
 *
 * Provide `GitHub.CreatePullRequestHttp` on a Worker or Function, or
 * `GitHub.CreatePullRequestLocal` on an Action.
 *
 * ### Opening Pull Requests at Runtime
 * **Example:** Open a pull request from a branch
 * ```typescript
 * const createPullRequest = yield* GitHub.CreatePullRequest(yield* Repo);
 * const pull = yield* createPullRequest({
 *   title: "fix: typo in README",
 *   head: "fix/readme-typo",
 *   base: "main",
 *   body: "Closes #7.",
 * });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface CreatePullRequest extends Binding.Service<
  CreatePullRequest,
  "GitHub.CreatePullRequest",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreatePullRequestRequest,
    ) => Effect.Effect<CreatePullRequestResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const CreatePullRequest = Binding.Service<CreatePullRequest>("GitHub.CreatePullRequest");
