import type { Octokit as _Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
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
