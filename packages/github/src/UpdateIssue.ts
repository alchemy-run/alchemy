import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError, IssueNotFound } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface UpdateIssueRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["update"]["parameters"]
> {}

export type UpdateIssueResponse = RestEndpointMethodTypes["issues"]["update"]["response"]["data"];

/**
 * Update one issue by number (`issues.update`): state, title, body, labels,
 * assignees. A missing issue fails with the typed `IssueNotFound`.
 *
 * Provide `GitHub.UpdateIssueHttp` on a Worker or Function, or
 * `GitHub.UpdateIssueLocal` on an Action.
 *
 * ### Updating Issues at Runtime
 * **Example:** Close an issue as completed
 * ```typescript
 * const updateIssue = yield* GitHub.UpdateIssue(yield* Repo);
 * yield* updateIssue({
 *   issue_number: 7,
 *   state: "closed",
 *   state_reason: "completed",
 * });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface UpdateIssue extends Binding.Service<
  UpdateIssue,
  "GitHub.UpdateIssue",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: UpdateIssueRequest,
    ) => Effect.Effect<UpdateIssueResponse, IssueNotFound | GitHubApiError, RuntimeContext>
  >
> {}

export const UpdateIssue = Binding.Service<UpdateIssue>("GitHub.UpdateIssue");
