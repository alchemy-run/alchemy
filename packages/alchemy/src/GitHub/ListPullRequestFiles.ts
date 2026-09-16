import type { RestEndpointMethodTypes } from "@octokit/rest";
import type * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import type { GitHubApiError } from "./ApiError.ts";
import type { EndpointParameters } from "./EndpointParameters.ts";
import type { RepositoryLike } from "./RepositoryLike.ts";

export interface ListPullRequestFilesRequest extends EndpointParameters<
  RestEndpointMethodTypes["pulls"]["listFiles"]["parameters"]
> {}

export type ListPullRequestFilesResponse =
  RestEndpointMethodTypes["pulls"]["listFiles"]["response"]["data"];

/**
 * List the files a pull request changes (`pulls.listFiles`), one page
 * at a time — each with its status, `+`/`−` counts, and the unified
 * `patch` of its hunks (omitted by GitHub for binaries and very large
 * files). Unlike `pulls.get` with `format: "diff"`, which refuses diffs
 * over 20 000 lines or 300 files, this endpoint pages through changes
 * of any size (up to 3 000 files, 100 per page).
 * **Example:** Example
 * ```typescript
 * const listFiles = yield* GitHub.ListPullRequestFiles(repo);
 * const page = yield* listFiles({ pull_number: 9, per_page: 100, page: 1 });
 * ```
 *
 * @binding
 */
export interface ListPullRequestFiles extends Binding.Service<
  ListPullRequestFiles,
  "GitHub.ListPullRequestFiles",
  (
    repo: RepositoryLike,
  ) => Effect.Effect<
    (
      request: ListPullRequestFilesRequest,
    ) => Effect.Effect<ListPullRequestFilesResponse, GitHubApiError>
  >
> {}

export const ListPullRequestFiles = Binding.Service<ListPullRequestFiles>(
  "GitHub.ListPullRequestFiles",
);
