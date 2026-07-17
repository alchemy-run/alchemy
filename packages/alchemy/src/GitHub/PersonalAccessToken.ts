import { Octokit as OctokitClient } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { GitHubCredentials } from "./Credentials.ts";
import type * as GitHub from "./Providers.ts";

export interface PersonalAccessTokenProps {
  /**
   * The token to capture. Defaults to the provider's ambient credential
   * (the same token `alchemy login` / `GITHUB_TOKEN` resolves), so the
   * common shape is `GitHub.PersonalAccessToken("token")` with no props.
   */
  token?: Redacted.Redacted<string>;
}

/**
 * A GitHub personal access token as a resource — the GitHub analogue of
 * `Cloudflare.AccountApiToken`, with one honest difference: GitHub has
 * no API to MINT tokens (neither classic nor fine-grained PATs), so
 * this resource does not create one. It **captures** a token — an
 * explicit `token` prop, or by default the provider's ambient
 * credential — **validates** it against the API, and persists it
 * (encrypted) so hosts can bind it:
 *
 * - `value` is the token itself (`Redacted`) — the `GitHub.*Http`
 *   binding layers yield it inside a host's init Effect, which binds it
 *   into the deployed Worker/Function's environment; the runtime client
 *   authenticates with it.
 * - `login` / `scopes` record WHO the token is and what it may do at
 *   the time it was captured — the deploy plan shows what the org is
 *   about to ship.
 *
 * Deleting the resource only forgets the token from state — revoking a
 * PAT is not exposed by GitHub's API and stays a human act.
 * @resource
 * @section Capturing a Token
 * @example The provider's credential (the common shape)
 * ```typescript
 * const token = yield* GitHub.PersonalAccessToken("factory-token");
 * ```
 *
 * @example An explicit token
 * ```typescript
 * const token = yield* GitHub.PersonalAccessToken("bot-token", {
 *   token: Redacted.make(process.env.BOT_GITHUB_TOKEN!),
 * });
 * ```
 */
/**
 * The classic-PAT OAuth scopes GitHub grants, as reported by the
 * `X-OAuth-Scopes` header. The union is OPEN (`string & {}` keeps
 * autocompletion without lying about the future): GitHub adds scopes
 * over time, and a captured token must never fail to read because the
 * wire reported one this list hasn't caught up with.
 *
 * @see {@link https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps | Scopes for OAuth apps}
 */
export type TokenScope =
  // repositories
  | "repo"
  | "repo:status"
  | "repo_deployment"
  | "public_repo"
  | "repo:invite"
  | "security_events"
  | "delete_repo"
  // repo hooks
  | "admin:repo_hook"
  | "write:repo_hook"
  | "read:repo_hook"
  // organizations
  | "admin:org"
  | "write:org"
  | "read:org"
  | "admin:org_hook"
  // keys
  | "admin:public_key"
  | "write:public_key"
  | "read:public_key"
  | "admin:gpg_key"
  | "write:gpg_key"
  | "read:gpg_key"
  | "admin:ssh_signing_key"
  | "write:ssh_signing_key"
  | "read:ssh_signing_key"
  // user
  | "user"
  | "read:user"
  | "user:email"
  | "user:follow"
  // projects, packages, discussions
  | "project"
  | "read:project"
  | "write:packages"
  | "read:packages"
  | "delete:packages"
  | "write:discussion"
  | "read:discussion"
  // misc
  | "gist"
  | "notifications"
  | "workflow"
  | "codespace"
  | "copilot"
  | "manage_billing:copilot"
  | "audit_log"
  | "read:audit_log"
  // enterprise
  | "admin:enterprise"
  | "manage_runners:enterprise"
  | "manage_billing:enterprise"
  | "read:enterprise"
  | "scim:enterprise"
  | (string & {});

export interface PersonalAccessToken extends Resource<
  "GitHub.PersonalAccessToken",
  PersonalAccessTokenProps,
  {
    /** The token value — bind it into a host to authenticate at runtime. */
    value: Redacted.Redacted<string>;
    /** The login the token authenticates as. */
    login: string;
    /** OAuth scopes (classic PATs; empty for fine-grained tokens). */
    scopes: TokenScope[];
  },
  never,
  GitHub.Providers
> {}

export const PersonalAccessToken = Resource<PersonalAccessToken>(
  "GitHub.PersonalAccessToken",
);

/** Validate a token and read its identity (login + classic scopes). */
const validate = Effect.fn(function* (token: Redacted.Redacted<string>) {
  const octokit = new OctokitClient({ auth: Redacted.value(token) });
  const response = yield* Effect.tryPromise({
    try: () => octokit.rest.users.getAuthenticated(),
    catch: (cause) => cause as Error & { status?: number },
  });
  const scopes = (response.headers["x-oauth-scopes"] ?? "")
    .split(",")
    .map((scope): TokenScope => scope.trim())
    .filter((scope) => scope.length > 0);
  return { login: response.data.login, scopes };
});

export const PersonalAccessTokenProvider = () =>
  Provider.succeed(PersonalAccessToken, {
    stables: ["value", "login"],
    // Non-listable: tokens are captured, never enumerated — GitHub has
    // no API to list PATs, and there is no cloud-side object to adopt.
    list: () => Effect.succeed([]),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      // The captured token is authoritative; a token revoked out-of-band
      // reads as gone so the next deploy re-captures a working one.
      const probe = yield* validate(output.value).pipe(Effect.result);
      return Result.isSuccess(probe)
        ? { ...output, ...probe.success }
        : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      // ONE flow: resolve the desired token (explicit prop, else the
      // provider's ambient credential), validate it, capture it.
      const token = news.token ?? (yield* yield* GitHubCredentials).token;
      const { login, scopes } = yield* validate(token).pipe(Effect.orDie);
      return { value: token, login, scopes };
    }),

    delete: Effect.fn(function* () {
      // Nothing to destroy: GitHub exposes no API to revoke a PAT.
      // Deleting the resource forgets the token from state only.
      yield* Effect.void;
    }),
  });
