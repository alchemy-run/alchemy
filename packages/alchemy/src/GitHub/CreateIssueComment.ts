import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface CreateIssueCommentRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["createComment"]["parameters"]
> {}

export type CreateIssueCommentResponse =
  RestEndpointMethodTypes["issues"]["createComment"]["response"]["data"];

/**
 * Comment on an issue or pull request (`issues.createComment` — one
 * door for both, GitHub's issues API). Named after the operation; the
 * `GitHub.Comment` RESOURCE (a comment whose lifecycle a Stack owns) is
 * a different thing.
 * **Example:** Example
 * ```typescript
 * const comment = yield* GitHub.CreateIssueComment(repo);
 * yield* comment({ issue_number: 7, body: "on it" });
 * ```
 *
 * @binding
 */
export interface CreateIssueComment extends Binding.Service<
  CreateIssueComment,
  "GitHub.CreateIssueComment",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: CreateIssueCommentRequest,
    ) => Effect.Effect<CreateIssueCommentResponse, GitHubApiError>
  >
> {}

export const CreateIssueComment = Binding.Service<CreateIssueComment>(
  "GitHub.CreateIssueComment",
);
