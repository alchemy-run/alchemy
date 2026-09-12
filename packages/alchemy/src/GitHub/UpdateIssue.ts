import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import { IssueNotFound } from "./GetIssue.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface UpdateIssueRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["update"]["parameters"]
> {}

export type UpdateIssueResponse =
  RestEndpointMethodTypes["issues"]["update"]["response"]["data"];

/**
 * Update one issue by number (`issues.update`) — state (open/closed
 * with a state_reason), title, body, labels. A missing issue is the
 * typed {@link IssueNotFound}, never a status check.
 * **Example:** Example
 * ```typescript
 * const updateIssue = yield* GitHub.UpdateIssue(repo);
 * yield* updateIssue({
 *   issue_number: 7,
 *   state: "closed",
 *   state_reason: "completed",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateIssue extends Binding.Service<
  UpdateIssue,
  "GitHub.UpdateIssue",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: UpdateIssueRequest,
    ) => Effect.Effect<UpdateIssueResponse, IssueNotFound | GitHubApiError>
  >
> {}

export const UpdateIssue = Binding.Service<UpdateIssue>("GitHub.UpdateIssue");
