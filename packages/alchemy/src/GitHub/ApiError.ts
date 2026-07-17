/**
 * The typed failure of every GitHub API binding ({@link ListIssues},
 * {@link MergePullRequest}, …). Bindings that can answer a request with
 * a domain fact (a missing issue) fail with their own tagged error
 * instead — `GitHubApiError` is the wire-level failure (auth, rate
 * limit, validation, network).
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class GitHubApiError extends Data.TaggedError("GitHub.ApiError")<{
  /** The Octokit operation, e.g. `issues.listForRepo`. */
  readonly operation: string;
  /** HTTP status when the API answered at all. */
  readonly status?: number;
  readonly message: string;
}> {}

/** Wrap one Octokit call; thrown request errors become {@link GitHubApiError}. */
export const githubCall = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, GitHubApiError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new GitHubApiError({
        operation,
        status: (cause as { status?: number }).status,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
