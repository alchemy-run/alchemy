/**
 * Shared scaffolding for the GitHub `*Http` and `*Local` binding layers.
 *
 * Each binding declares its Octokit call once with {@link operation}. `make`
 * runs it with a {@link PersonalAccessToken} bound into the host (one token
 * resource per host, shared by every GitHub binding on it); `BindingLocal.make`
 * runs it with the provider's current credentials.
 *
 * NOT exported from `index.ts`.
 */
import { Octokit as OctokitClient } from "@octokit/rest";
import { Self } from "alchemy/Self";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { type GitHubApiError, githubCall } from "./ApiError.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { PersonalAccessToken } from "./PersonalAccessToken.ts";
import type { Repository } from "./Repository.ts";

/** The bound repository, as an operation sees it. */
export interface BoundRepository {
  readonly owner: string;
  readonly repository: string;
}

/**
 * One Octokit call, implemented by both the `*Http` and `*Local` layers.
 * `name` is the Octokit operation; it names the span and the `operation` of
 * every {@link GitHubApiError}. `mapError` turns a wire failure into a domain
 * answer (a 404 from `issues.get` into `IssueNotFound`).
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
): Operation<Request, Out, E> => ({ name, call, mapError: options?.mapError });

/** The Octokit a client calls with: a token and the API base URL. */
export interface OctokitSource {
  readonly token: Effect.Effect<Redacted.Redacted<string>>;
  readonly apiUrl: Effect.Effect<string | undefined>;
}

/**
 * Bind a repository and return the runtime client for `op`. The repository's
 * `fullName` is bound into the host, so the client resolves it at runtime.
 */
export const makeOperationClient = <Request extends ReadonlyArray<any>, Out, E>(
  op: Operation<Request, Out, E>,
  source: OctokitSource,
) =>
  Effect.fn(function* (repo: Repository) {
    const fullName = yield* repo.fullName;
    // A per-repository `baseUrl` prop wins over the token's host.
    const repoBaseUrl =
      typeof repo.Props?.baseUrl === "string"
        ? yield* normalizeGitHubBaseUrl(repo.Props.baseUrl).pipe(Effect.orDie)
        : undefined;
    return Effect.fn(`GitHub.${op.name}`)(function* (...request: Request) {
      const [owner, repository] = (yield* fullName).split("/") as [string, string];
      const identity = { owner, repository };
      const octokit = new OctokitClient({
        auth: Redacted.value(yield* source.token),
        baseUrl: repoBaseUrl ?? (yield* source.apiUrl),
      });
      const wire = githubCall(op.name, () => op.call(octokit, identity)(...request));
      const response = yield* op.mapError === undefined
        ? wire
        : Effect.mapError(wire, (error) => op.mapError!(error, { repo: identity, request }));
      return response.data;
    });
  });

/**
 * The token-backed implementation of a GitHub binding. Pass it to
 * `Layer.effect(Tag, BindingHttp.make(op))`.
 */
export const make = <Request extends ReadonlyArray<any>, Out, E>(op: Operation<Request, Out, E>) =>
  Effect.gen(function* () {
    const Token = yield* PersonalAccessToken;
    const self = yield* Self;
    const token = yield* Token(`${self.LogicalId}GitHubToken`);
    return makeOperationClient(op, {
      token: yield* token.value,
      apiUrl: yield* token.apiUrl,
    });
  });
