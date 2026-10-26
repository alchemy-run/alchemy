import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";

/**
 * The wire-level failure of every GitHub runtime binding (auth, rate limit,
 * validation, network). Bindings that can answer a request with a domain fact
 * fail with their own tagged error instead — `IssueNotFound` for a
 * missing issue.
 */
export class GitHubApiError extends Data.TaggedError("GitHubApiError")<{
  /** The Octokit operation, e.g. `issues.listForRepo`. */
  readonly operation: string;
  /** HTTP status, when GitHub answered at all. */
  readonly status?: number;
  readonly message: string;
}> {}

/** The issue does not exist in the repository. */
export class IssueNotFound extends Data.TaggedError("IssueNotFound")<{
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}> {}

/** Wrap one Octokit call; a rejected request becomes a {@link GitHubApiError}. */
export const githubCall = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, GitHubApiError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new GitHubApiError({
        operation,
        status:
          Predicate.hasProperty(cause, "status") && typeof cause.status === "number"
            ? cause.status
            : undefined,
        message:
          Predicate.hasProperty(cause, "message") && typeof cause.message === "string"
            ? cause.message
            : String(cause),
      }),
  });
