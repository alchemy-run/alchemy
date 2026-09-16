/**
 * Shared scaffolding for the GitHub `*Http` binding implementations —
 * the GitHub analogue of the Cloudflare `{Cap}Http.ts` convention.
 *
 * `make(op)` builds the TOKEN-BACKED implementation: it captures the
 * provider's credential as a {@link PersonalAccessToken} resource named
 * after the host (`${LogicalId}GitHubToken` — FQN-memoized, so every
 * GitHub binding on one host shares ONE token resource), and
 * authenticates each operation with the token's bound `value`. Yielding
 * the attribute from the host's init Effect is what binds it into the
 * deployed environment; at runtime the same accessor reads it back.
 *
 * The per-operation sandwich itself (resolve the {@link RepositoryLike}
 * once per bind, wrap each call in {@link githubCall} under a traced
 * span, return `data`) is {@link makeOperationClient} — shared with the
 * `*Local` layers (BindingLocal.ts), which run the SAME operations off
 * the provider's ambient credentials instead of a bound token.
 *
 * NOT exported from `index.ts` (internal scaffolding).
 */
import { Octokit as OctokitClient } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Self } from "../Self.ts";
import { type GitHubApiError, githubCall } from "./ApiError.ts";
import { PersonalAccessToken } from "./PersonalAccessToken.ts";
import { type RepositoryLike, resolveRepository } from "./RepositoryLike.ts";

/** The bound repository's resolved identity, as the operation sees it. */
export interface BoundRepository {
  readonly owner: string;
  readonly repository: string;
}

/**
 * One Octokit operation, declared ONCE and implemented by both the
 * `*Http` (token-backed) and `*Local` (ambient-credentials) layers.
 * `name` names the Octokit op — it becomes the traced span
 * (`GitHub.issues.listForRepo(owner/repo)`) and the `operation` field
 * of every {@link GitHubApiError}; `mapError` lets an operation turn a
 * wire failure into its domain answer (GetIssue's 404 →
 * `IssueNotFound`).
 */
export interface Operation<Request extends ReadonlyArray<any>, Out, E = never> {
  readonly name: string;
  readonly call: (
    octokit: OctokitClient,
    repo: BoundRepository,
  ) => (...request: Request) => Promise<{ data: Out }>;
  readonly mapError?: (
    error: GitHubApiError,
    context: { repo: BoundRepository; request: Request },
  ) => GitHubApiError | E;
}

export const operation = <Request extends ReadonlyArray<any>, Out, E = never>(
  name: string,
  call: Operation<Request, Out, E>["call"],
  options?: { mapError?: Operation<Request, Out, E>["mapError"] },
): Operation<Request, Out, E> => ({
  name,
  call,
  mapError: options?.mapError,
});

/**
 * The operation sandwich over ANY Octokit source — resolve the
 * repository once per bind, then wrap each call: traced span, typed
 * wire errors, `data` unwrapped.
 */
export const makeOperationClient = <Request extends ReadonlyArray<any>, Out, E>(
  op: Operation<Request, Out, E>,
  octokit: Effect.Effect<OctokitClient>,
) =>
  Effect.fn(function* (repo: RepositoryLike) {
    const identity = yield* resolveRepository(repo);
    return Effect.fn(
      `GitHub.${op.name}(${identity.owner}/${identity.repository})`,
    )(function* (...request: Request) {
      const client = yield* octokit;
      const wire = githubCall(op.name, () =>
        op.call(client, identity)(...request),
      );
      const response = yield* op.mapError === undefined
        ? wire
        : Effect.mapError(wire, (error) =>
            op.mapError!(error, { repo: identity, request }),
          );
      return response.data;
    });
  });

/**
 * Build the token-backed implementation Effect of a GitHub binding —
 * pass the result straight to `Layer.effect(Tag, …)`:
 *
 * ```ts
 * export const listIssuesOperation = BindingHttp.operation(
 *   "issues.listForRepo",
 *   (octokit, repo) => (request?: ListIssuesRequest) =>
 *     octokit.rest.issues.listForRepo({
 *       owner: repo.owner,
 *       repo: repo.repository,
 *       ...request,
 *     }),
 * );
 * export const ListIssuesHttp = Layer.effect(
 *   ListIssues,
 *   BindingHttp.make(listIssuesOperation),
 * );
 * ```
 */
export const make = <Request extends ReadonlyArray<any>, Out, E>(
  op: Operation<Request, Out, E>,
) =>
  Effect.gen(function* () {
    const Token = yield* PersonalAccessToken;
    const self = yield* Self;
    // ONE token resource per host (FQN-memoized across every GitHub
    // binding the host uses). At deploy this captures + validates the
    // provider credential; yielding `value` below binds it into the
    // host's environment, and at runtime the same accessor reads it
    // back — the client authenticates with the BOUND token, never the
    // deploy-time ambient credential.
    const token = yield* Token(`${self.LogicalId}GitHubToken`, {});
    const value = yield* token.value;
    const octokit = Effect.map(
      value,
      (v) => new OctokitClient({ auth: Redacted.value(v) }),
    );
    return makeOperationClient(op, octokit);
  });
