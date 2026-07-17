import type { RestEndpointMethodTypes } from "@octokit/rest";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface GetIssueRequest extends EndpointParameters<
  RestEndpointMethodTypes["issues"]["get"]["parameters"]
> {}

export type GetIssueResponse =
  RestEndpointMethodTypes["issues"]["get"]["response"]["data"];

/** The issue does not exist in the repository — a domain answer, not a wire failure. */
export class IssueNotFound extends Data.TaggedError("GitHub.IssueNotFound")<{
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}> {}

/**
 * Get one issue by number (`issues.get`). A missing issue is the typed
 * {@link IssueNotFound}, never a status check.
 * @binding
 * @example
 * ```typescript
 * const getIssue = yield* GitHub.GetIssue(repo);
 * const issue = yield* getIssue({ issue_number: 7 });
 * ```
 */
export interface GetIssue extends Binding.Service<
  GetIssue,
  "GitHub.GetIssue",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: GetIssueRequest,
    ) => Effect.Effect<GetIssueResponse, IssueNotFound | GitHubApiError>
  >
> {}

export const GetIssue = Binding.Service<GetIssue>("GitHub.GetIssue");
