import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { Repository } from "./Repository.ts";

export interface ListIssueCommentsRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["listComments"]["parameters"]
> {}

export type ListIssueCommentsResponse =
  RestEndpointMethodTypes["issues"]["listComments"]["response"]["data"];

/**
 * List one page of the comments on an issue or pull request
 * (`issues.listComments`), oldest first. Pass a pull request's number as
 * `issue_number`.
 *
 * Provide `GitHub.ListIssueCommentsHttp` on a Worker or Function, or
 * `GitHub.ListIssueCommentsLocal` on an Action.
 *
 * ### Listing Comments at Runtime
 * **Example:** Read an issue's thread
 * ```typescript
 * const listComments = yield* GitHub.ListIssueComments(yield* Repo);
 * const comments = yield* listComments({ issue_number: 7, per_page: 100 });
 * ```
 *
 * @binding
 * @product Issue
 */
export interface ListIssueComments extends Binding.Service<
  ListIssueComments,
  "GitHub.ListIssueComments",
  (
    repo: Repository,
  ) => Effect.Effect<
    (
      request: ListIssueCommentsRequest,
    ) => Effect.Effect<ListIssueCommentsResponse, GitHubApiError, RuntimeContext>
  >
> {}

export const ListIssueComments = Binding.Service<ListIssueComments>("GitHub.ListIssueComments");
