import { Octokit as _Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createSign } from "node:crypto";
import type { AuthError } from "../Auth/AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { GitHubCredentials } from "./Credentials.ts";

export const Octokit: Effect.Effect<_Octokit, never, GitHubCredentials> =
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    return creds.octokit();
  });

/**
 * An Octokit honoring a per-resource `baseUrl` prop. When `baseUrl` is set,
 * it is normalized and used for this Octokit only (including an explicit
 * `"github.com"`, which overrides an enterprise-wide credential host back to
 * the default). When unset, falls back to the credentials' host — the
 * `GitHub.providers({ baseUrl })` hard-code or the auth provider's resolved
 * host.
 */
export const octokitFor = (
  baseUrl: string | undefined,
): Effect.Effect<_Octokit, AuthError, GitHubCredentials> =>
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    return baseUrl === undefined
      ? creds.octokit()
      : creds.octokit({ baseUrl: yield* normalizeGitHubBaseUrl(baseUrl) });
  });

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

/**
 * An Octokit authenticated as a GitHub App: a short-lived RS256 JWT signed
 * with the app's private key (Octokit sends a three-part token as a Bearer
 * JWT). Build one per call — the JWT expires after nine minutes.
 */
export const appOctokit = (
  appId: number,
  privateKey: Redacted.Redacted<string>,
  baseUrl: string | undefined,
): _Octokit => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  // `iat` is backdated a minute to tolerate clock drift, as GitHub advises.
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iat: now - 60,
    exp: now + 540,
    iss: String(appId),
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(body)
    .sign(Redacted.value(privateKey), "base64url");
  return new _Octokit({
    auth: `${body}.${signature}`,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
};

/** Run an Octokit call, resolving to `undefined` on the given HTTP statuses. */
export const unlessStatus = <A>(
  statuses: ReadonlyArray<number>,
  call: () => Promise<A>,
): Effect.Effect<A | undefined, Error> =>
  Effect.tryPromise({
    try: () =>
      call().catch((error: unknown) => {
        if (
          Predicate.hasProperty(error, "status") &&
          statuses.some((status) => status === error.status)
        ) {
          return undefined;
        }
        throw error;
      }),
    catch: (error) =>
      error instanceof Error ? error : new Error(String(error)),
  });

const freshAppKeyMessage = "Integration must generate a public key";

const isFreshAppKey = (error: unknown): boolean =>
  (Predicate.hasProperty(error, "message") &&
    typeof error.message === "string" &&
    error.message.includes(freshAppKeyMessage)) ||
  (Predicate.hasProperty(error, "cause") && isFreshAppKey(error.cause));

// GitHub rejects a freshly minted app key's JWT for a few seconds after the
// registration; the call succeeds once the key has propagated.
export const retryFreshAppKey = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    while: isFreshAppKey,
    schedule: Schedule.spaced("2 seconds"),
    times: 10,
  });
