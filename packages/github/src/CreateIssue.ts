import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface CreateIssueRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["create"]["parameters"]
> {}

export type CreateIssueResponse = RestEndpointMethodTypes["issues"]["create"]["response"]["data"];

/**
 * Open an issue in the bound repository (`issues.create`).
 *
 * Provide `GitHub.CreateIssueHttp` on a Worker or Function, or
 * `GitHub.CreateIssueLocal` on an Action.
 *
 * ### Opening Issues at Runtime
 * **Example:** Open an issue from a Worker
 * ```typescript
 * const createIssue = yield* GitHub.CreateIssue(yield* Repo);
 * const issue = yield* createIssue({
 *   title: "Deploy failed",
 *   body: "See the logs for details.",
 *   labels: ["incident"],
 * });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface CreateIssue extends Binding.Service<
  CreateIssue,
  "GitHub.CreateIssue",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreateIssueRequest,
    ) => Effect.Effect<CreateIssueResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const CreateIssue = Binding.Service<CreateIssue>("GitHub.CreateIssue");
