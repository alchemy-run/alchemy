/**
 * GitHub App credentials — the bot-identity story.
 *
 * A GitHub App cannot be CREATED by API (GitHub only supports the
 * manifest flow / enterprise endpoints), so registration is a one-time
 * manual step in the GitHub UI. Everything after that is managed here:
 * {@link fromApp} is a `GitHubCredentials` layer that signs the App
 * JWT, exchanges it for an INSTALLATION token, caches it, and refreshes
 * before expiry — every consumer of `GitHubCredentials` (bindings,
 * polling, git-over-https) transparently acts AS the app.
 *
 * Why an App instead of the operator's PAT: actions post under the
 * app's own actor (`my-bot[bot]`), which unlocks what GitHub forbids
 * the PR author — e.g. `REQUEST_CHANGES` reviews on your own pull
 * requests — and scopes permissions to exactly what the bot needs.
 */
import crypto from "node:crypto";
import { Octokit } from "@octokit/rest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { AuthError } from "../Auth/AuthProvider.ts";
import { normalizeGitHubBaseUrl } from "./BaseUrl.ts";
import { GitHubCredentials } from "./Credentials.ts";

export interface GitHubAppOptions {
  /** The App ID (numeric, shown on the app's settings page). */
  readonly appId: number | string;
  /**
   * The app's private key: the PEM as downloaded from the UI, a
   * base64-encoded PEM (safer to carry through env vars), or a PEM
   * with `\n` escapes.
   */
  readonly privateKey: string | Redacted.Redacted<string>;
  /**
   * The installation to act as. Omit to resolve it from
   * {@link GitHubAppOptions.repository} — pass one or the other.
   */
  readonly installationId?: number;
  /** Resolve the installation covering this repository. */
  readonly repository?: {
    readonly owner: string;
    readonly repository: string;
  };
  /** GitHub Enterprise host (normalized like the other layers). */
  readonly baseUrl?: string;
}

/** Accept raw PEM, `\n`-escaped PEM, or base64-encoded PEM. */
const normalizePem = (raw: string): string => {
  const unescaped = raw.includes("\\n") ? raw.replaceAll("\\n", "\n") : raw;
  if (unescaped.includes("-----BEGIN")) return unescaped;
  return Buffer.from(unescaped, "base64").toString("utf8");
};

const base64url = (data: string | Buffer): string =>
  Buffer.from(data).toString("base64url");

/**
 * The App JWT: RS256, `iss` = app id, valid 9 minutes (GitHub caps at
 * 10; the minute of slack absorbs clock skew).
 */
const signAppJwt = (appId: string, pem: string) =>
  Effect.try({
    try: () => {
      const now = Math.floor(Date.now() / 1000);
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
      const payload = base64url(
        JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
      );
      const key = crypto.createPrivateKey(pem);
      // encoded via the base64url helper rather than a direct
      // `.toString("base64url")`: a latent tsgo (TS 7 preview) checker
      // bug can degrade the global Buffer type in large programs and
      // reject encoding-taking toString overloads on Node API returns
      const signature = base64url(
        crypto.sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key),
      );
      return `${header}.${payload}.${signature}`;
    },
    catch: (cause) =>
      new AuthError({
        message: `GitHub App JWT signing failed (is the private key the PEM from the app's settings page?): ${cause}`,
      }),
  });

interface TokenState {
  readonly token: Redacted.Redacted<string>;
  /** epoch ms; refresh 5 minutes early. */
  readonly expiresAt: number;
  readonly installationId: number;
}

/**
 * A `GitHubCredentials` layer authenticating AS a GitHub App
 * installation. The credential effect is re-evaluated on every use, so
 * the hour-long installation tokens refresh transparently:
 *
 * ```ts
 * const AppCredentials = GitHub.fromApp({
 *   appId: yield* Config.string("GITHUB_APP_ID"),
 *   privateKey: yield* Config.redacted("GITHUB_APP_PRIVATE_KEY"),
 *   repository: { owner: "alchemy-run", repository: "test-alchemy" },
 * });
 * ```
 */
export const fromApp = (
  options: GitHubAppOptions,
): Layer.Layer<GitHubCredentials> =>
  Layer.effect(
    GitHubCredentials,
    Effect.gen(function* () {
      if (
        options.installationId === undefined &&
        options.repository === undefined
      ) {
        return yield* Effect.die(
          new AuthError({
            message:
              "GitHub.fromApp needs `installationId` or `repository` to resolve the installation",
          }),
        );
      }
      const appId = String(options.appId);
      const pem = normalizePem(
        typeof options.privateKey === "string"
          ? options.privateKey
          : Redacted.value(options.privateKey),
      );
      const baseUrl =
        options.baseUrl !== undefined
          ? yield* normalizeGitHubBaseUrl(options.baseUrl).pipe(Effect.orDie)
          : undefined;

      const state = yield* Ref.make<TokenState | undefined>(undefined);
      const gate = Semaphore.makeUnsafe(1);

      const refresh = Effect.gen(function* () {
        const jwt = yield* signAppJwt(appId, pem);
        const asApp = new Octokit({
          auth: jwt,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
        const installationId =
          options.installationId ??
          (yield* Effect.tryPromise({
            try: () =>
              asApp.rest.apps.getRepoInstallation({
                owner: options.repository!.owner,
                repo: options.repository!.repository,
              }),
            catch: (cause) =>
              new AuthError({
                message: `GitHub App installation lookup failed for ${options.repository!.owner}/${options.repository!.repository} (is the app installed on the repository?): ${cause}`,
              }),
          })).data.id;
        const created = yield* Effect.tryPromise({
          try: () =>
            asApp.rest.apps.createInstallationAccessToken({
              installation_id: installationId,
            }),
          catch: (cause) =>
            new AuthError({
              message: `GitHub App installation token exchange failed: ${cause}`,
            }),
        });
        const next: TokenState = {
          token: Redacted.make(created.data.token),
          expiresAt: Date.parse(created.data.expires_at),
          installationId,
        };
        yield* Ref.set(state, next);
        return next;
      });

      const service = (token: Redacted.Redacted<string>) => ({
        token,
        baseUrl,
        octokit: (override?: { baseUrl: string | undefined }) => {
          const url = override !== undefined ? override.baseUrl : baseUrl;
          return new Octokit({
            auth: Redacted.value(token),
            ...(url !== undefined ? { baseUrl: url } : {}),
          });
        },
      });

      // the credentials VALUE is this effect — evaluated per use, so
      // expiry is checked (and the token refreshed) on every Octokit
      return Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (
          current !== undefined &&
          current.expiresAt - Date.now() > 5 * 60 * 1000
        ) {
          return service(current.token);
        }
        // one refresher at a time; losers re-read the fresh state
        const next = yield* gate.withPermits(1)(
          Effect.gen(function* () {
            const raced = yield* Ref.get(state);
            if (
              raced !== undefined &&
              raced.expiresAt - Date.now() > 5 * 60 * 1000
            ) {
              return raced;
            }
            return yield* refresh;
          }),
        );
        return service(next.token);
      }).pipe(Effect.orDie);
    }),
  );
