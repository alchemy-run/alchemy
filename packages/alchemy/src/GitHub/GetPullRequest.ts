import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface GetPullRequestRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["get"]["parameters"]
> {
  /**
   * Media-type projection of the SAME operation: `"diff"` / `"patch"`
   * return the raw text a reviewer reads instead of the JSON object.
   */
  readonly format?: "diff" | "patch";
}

export type GetPullRequestResponse =
  RestEndpointMethodTypes["pulls"]["get"]["response"]["data"];

/**
 * Fetch a pull request (`pulls.get`). The one general read — pass
 * `format: "diff"` (or `"patch"`) to receive the raw unified diff text
 * instead of the JSON object; the return type follows the request.
 * @binding
 * @example
 * ```typescript
 * const getPullRequest = yield* GitHub.GetPullRequest(repo);
 * const pull = yield* getPullRequest({ pull_number: 9 });
 * const diff = yield* getPullRequest({ pull_number: 9, format: "diff" });
 * ```
 */
export interface GetPullRequest extends Binding.Service<
  GetPullRequest,
  "GitHub.GetPullRequest",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    <Format extends "diff" | "patch" | undefined = undefined>(
      request: GetPullRequestRequest & { readonly format?: Format },
    ) => Effect.Effect<
      Format extends "diff" | "patch" ? string : GetPullRequestResponse,
      GitHubApiError
    >
  >
> {}

export const GetPullRequest = Binding.Service<GetPullRequest>(
  "GitHub.GetPullRequest",
);
