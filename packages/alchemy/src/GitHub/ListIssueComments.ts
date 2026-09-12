import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListIssueCommentsRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["listComments"]["parameters"]
> {}

export type ListIssueCommentsResponse =
  RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"];

/**
 * List the comments on an issue or pull request (`issues.listComments`)
 * — the conversation thread, oldest first. Pull requests are issues to
 * this endpoint: pass the PR number as `issue_number`.
 * **Example:** Example
 * ```typescript
 * const listComments = yield* GitHub.ListIssueComments(repo);
 * const comments = yield* listComments({ issue_number: 9, per_page: 100 });
 * ```
 *
 * @binding
 */
export interface ListIssueComments extends Binding.Service<
  ListIssueComments,
  "GitHub.ListIssueComments",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: ListIssueCommentsRequest,
    ) => Effect.Effect<ListIssueCommentsResponse, GitHubApiError>
  >
> {}

export const ListIssueComments = Binding.Service<ListIssueComments>(
  "GitHub.ListIssueComments",
);
