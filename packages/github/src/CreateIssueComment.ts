import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface CreateIssueCommentRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["createComment"]["parameters"]
> {}

export type CreateIssueCommentResponse =
  RestEndpointMethodTypes["issues"]["createComment"]["response"]["data"];

/**
 * Comment on an issue or pull request (`issues.createComment`). Pass a pull
 * request's number as `issue_number`.
 *
 * Provide `GitHub.CreateIssueCommentHttp` on a Worker or Function, or
 * `GitHub.CreateIssueCommentLocal` on an Action.
 *
 * ### Commenting at Runtime
 * **Example:** Reply on an issue
 * ```typescript
 * const createComment = yield* GitHub.CreateIssueComment(yield* Repo);
 * yield* createComment({ issue_number: 7, body: "On it." });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface CreateIssueComment extends Binding.Service<
  CreateIssueComment,
  "GitHub.CreateIssueComment",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: CreateIssueCommentRequest,
    ) => Effect.Effect<CreateIssueCommentResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const CreateIssueComment = Binding.Service<CreateIssueComment>("GitHub.CreateIssueComment");
