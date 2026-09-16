import * as DistilledGitHubCredentials from "@distilled.cloud/github/Credentials";
import * as Effect from "effect/Effect";
import type { AuthError } from "../Auth/AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { GitHubCredentials } from "./Credentials.ts";

/** Provide distilled credentials, honoring a resource's explicit host override. */
export const githubFor = (baseUrl?: string) =>
  Effect.gen(function* () {
    const creds = yield* yield* GitHubCredentials;
    const apiBaseUrl =
      baseUrl === undefined
        ? creds.baseUrl
        : yield* normalizeGitHubBaseUrl(baseUrl);
    return Effect.provideService(
      DistilledGitHubCredentials.Credentials,
      Effect.succeed({
        token: creds.token,
        apiBaseUrl:
          apiBaseUrl ?? DistilledGitHubCredentials.DEFAULT_API_BASE_URL,
        userAgent: "Alchemy (alchemy.run)",
      }),
    );
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
