import type * as Pulls from "@distilled.cloud/github/pulls";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Repository } from "./Repository.ts";

export interface GetPullRequestRequest extends Omit<Pulls.GetRequest, "owner" | "repo"> {
  /** Return the raw `diff` or `patch` text instead of the JSON object. */
  readonly format?: "diff" | "patch";
}

export type GetPullRequestResponse = Pulls.PullRequest;

/**
 * Get a pull request by number (`pulls.get`). Pass `format: "diff"` or
 * `format: "patch"` to get the raw diff text instead of the JSON object.
 *
 * Provide `GitHub.GetPullRequestHttp` on a Worker or Function, or
 * `GitHub.GetPullRequestLocal` on an Action.
 *
 * ### Reading Pull Requests at Runtime
 * **Example:** Get a pull request and its diff
 * ```typescript
 * const getPullRequest = yield* GitHub.GetPullRequest(yield* Repo);
 * const pull = yield* getPullRequest({ pull_number: 9 });
 * const diff = yield* getPullRequest({ pull_number: 9, format: "diff" });
 * ```
 *
 * @binding
 * @product Pull Request
 */
export interface GetPullRequest extends Binding.Service<
  GetPullRequest,
  "GitHub.GetPullRequest",
  (
    repo: Repository,
  ) => Effect.Effect<
    <Format extends "diff" | "patch" | undefined = undefined>(
      request: GetPullRequestRequest & { readonly format?: Format },
    ) => Effect.Effect<
      Format extends "diff" | "patch" ? string : GetPullRequestResponse,
      Pulls.GetError | Pulls.GetDiffError,
      RuntimeContext
    >
  >
> {}

export const GetPullRequest = Binding.Service<GetPullRequest>("GitHub.GetPullRequest");
