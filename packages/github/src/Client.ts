import {
  Credentials,
  DEFAULT_API_BASE_URL,
  type Config,
} from "@distilled.cloud/github/Credentials";
import * as Meta from "@distilled.cloud/github/meta";
import * as Repos from "@distilled.cloud/github/repos";
import type { AuthError } from "alchemy/Auth/AuthProvider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { GitHubCredentials } from "./Credentials.ts";

/** The User-Agent alchemy sends; GitHub rejects requests without one. */
export const USER_AGENT = "alchemy";

/** Distilled credentials for a token on a REST API base URL (`undefined` is github.com). */
export const githubConfig = (token: Config["token"], apiBaseUrl: string | undefined): Config => ({
  token,
  apiBaseUrl: apiBaseUrl ?? DEFAULT_API_BASE_URL,
  userAgent: USER_AGENT,
});

/**
 * The distilled credentials for a resource's `baseUrl` prop. When set, it is
 * normalized and wins (including an explicit `"github.com"`, which overrides
 * an enterprise-wide credential host back to the default). When unset, the
 * credentials' own host applies: the `GitHub.providers({ baseUrl })` pin or
 * the auth provider's resolved host.
 */
export const configFor = (
  baseUrl: string | undefined,
): Effect.Effect<Config, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    const apiBaseUrl =
      baseUrl === undefined ? creds.baseUrl : yield* normalizeGitHubBaseUrl(baseUrl);
    return githubConfig(creds.token, apiBaseUrl);
  });

/**
 * Provide a resource's GitHub host to distilled operations:
 *
 * ```ts
 * const github = yield* githubFor(news.baseUrl);
 * const repo = yield* github(Repos.get({ owner, repo }));
 * ```
 */
export const githubFor = (baseUrl: string | undefined) =>
  Effect.map(
    configFor(baseUrl),
    (config) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Credentials>> =>
        Effect.provideService(effect, Credentials, Effect.succeed(config)),
  );

/** The provider's default GitHub host, for calls that aren't tied to a resource. */
export const github = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(githubFor(undefined), (provide) => provide(effect));

/**
 * The host a resource's `baseUrl` prop actually resolves to: the normalized
 * prop when set, otherwise the credentials' host — which already reflects
 * `GitHub.providers({ baseUrl })` or the auth provider's resolved host.
 */
export const effectiveGitHubBaseUrl = (
  baseUrl: string | undefined,
): Effect.Effect<string | undefined, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    if (baseUrl !== undefined) {
      return yield* normalizeGitHubBaseUrl(baseUrl);
    }
    const creds = yield* yield* GitHubCredentials;
    return creds.baseUrl;
  });

/**
 * Whether a resource's EFFECTIVE GitHub host changed between deploys — used
 * by resource `diff` implementations to decide replacement (a resource with
 * the same name on a different GitHub instance is a different physical
 * resource).
 *
 * Each side is resolved through the full fallback chain (explicit prop →
 * `providers({ baseUrl })` → auth provider host) and normalized before
 * comparing, so neither a cosmetic rewrite (`github.example.com` →
 * `https://github.example.com/api/v3`) nor making the ambient default
 * explicit (prop `undefined` → prop equal to the credentials' host) triggers
 * a replacement — and dropping back to github.com from an enterprise-wide
 * credential host is correctly detected as a change.
 */
export const gitHubBaseUrlChanged = (
  olds: { baseUrl?: string },
  news: { baseUrl?: string },
): Effect.Effect<boolean, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    const oldUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
    const newUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);
    return oldUrl !== newUrl;
  });

/** The largest page GitHub's list endpoints serve. */
export const PER_PAGE = 100;

/**
 * Every item of a page-numbered GitHub list, fetched lazily one page at a
 * time. `fetch(page)` requests that page with `per_page: PER_PAGE`; a short
 * page is the last one.
 *
 * ```ts
 * const hooks = yield* paginate((page) =>
 *   github(Repos.listWebhooks({ owner, repo, per_page: PER_PAGE, page })),
 * ).pipe(Stream.runCollect);
 * ```
 */
export const paginate = <A, E, R>(
  fetch: (page: number) => Effect.Effect<ReadonlyArray<A>, E, R>,
): Stream.Stream<A, E, R> =>
  Stream.paginate(1, (page: number) =>
    Effect.map(
      fetch(page),
      (items) =>
        [items, items.length < PER_PAGE ? Option.none<number>() : Option.some(page + 1)] as const,
    ),
  );

/** {@link paginate}, collected into an array. */
export const listAll = <A, E, R>(fetch: (page: number) => Effect.Effect<ReadonlyArray<A>, E, R>) =>
  Effect.map(Stream.runCollect(paginate(fetch)), (items) => Array.from(items));

/**
 * Every repository the provider's token can see, across all the owners and
 * organizations it belongs to: the ambient scope `list` enumerates.
 */
export const listRepositories = listAll((page) =>
  github(Repos.listForAuthenticatedUser({ per_page: PER_PAGE, page })),
);

/** GitHub answered a GraphQL request with `errors`. */
export class GitHubGraphqlError extends Data.TaggedError("GitHubGraphqlError")<{
  readonly message: string;
}> {}

/**
 * Run a GraphQL document against a resource's GitHub host, for the few
 * operations REST doesn't offer (e.g. toggling a pull request's draft state).
 * GitHub reports GraphQL failures in `errors` with a 200 response; they fail
 * with {@link GitHubGraphqlError}.
 */
export const graphql = Effect.fn(function* (
  baseUrl: string | undefined,
  query: string,
  variables: Record<string, unknown>,
) {
  const github = yield* githubFor(baseUrl);
  const response = yield* github(Meta.graphql({ query, variables }));
  if (response.errors?.length) {
    return yield* new GitHubGraphqlError({
      message: response.errors.map((error) => error.message).join("; "),
    });
  }
  return response.data;
});
