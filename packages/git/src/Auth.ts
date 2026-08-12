/**
 * Credential parsing and the live `GitAuth` middleware (DESIGN.md §8).
 *
 * The Worker/middleware layer only *parses* credentials — a repo token
 * (`gs_...`) or the deployer admin key — into the `Credentials` service.
 * Enforcement lives elsewhere:
 *
 * - repo tokens are verified by the Repo DO, which owns the `tokens`
 *   table (`verifyToken(sha256(token), requiredScope)`), and
 * - the admin key is verified at the Worker with the timing-safe compare
 *   exported here ({@link timingSafeEqual} / {@link verifyAdminKey}).
 *
 * Two entry points parse the same wire formats:
 *
 * - REST routes go through {@link GitAuthLive} (Effect HttpApi security
 *   middleware, Bearer or Basic), and
 * - the raw git wire routes (`info/refs`, `git-upload-pack`,
 *   `git-receive-pack`) call {@link parseBasicOrBearer} on the raw
 *   headers, since they live outside HttpApi schema-land.
 */
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import crypto from "node:crypto";
import { Credentials, GitAuth, Unauthorized } from "./Api.ts";

/**
 * Prefix of every minted per-repo token. The full format is
 * `gs_<base64url(32 random bytes)>` (DESIGN.md §8).
 */
export const TOKEN_PREFIX = "gs_" as const;

/**
 * The parsed credential carried by a request — the same shape the
 * `Credentials` context service provides to REST handlers.
 */
export interface ParsedCredentials {
  /** The raw secret presented by the client (repo token or admin key). */
  readonly token: Redacted.Redacted<string>;
}

/**
 * Splits an `Authorization` header into scheme + credential per RFC 9110
 * §11.1: the scheme is case-insensitive and the credential follows one or
 * more spaces.
 */
const parseAuthorization = (
  authorization: string | undefined,
): { readonly scheme: string; readonly credential: string } | undefined => {
  if (authorization === undefined) return undefined;
  const space = authorization.indexOf(" ");
  if (space === -1) return undefined;
  const scheme = authorization.slice(0, space).toLowerCase();
  let start = space + 1;
  while (authorization.charCodeAt(start) === 32) start++;
  if (start >= authorization.length) return undefined;
  return { scheme, credential: authorization.slice(start) };
};

/**
 * Parses `Authorization: Bearer <token>` or `Authorization: Basic
 * <base64(user:pass)>` request headers into {@link ParsedCredentials}.
 *
 * Basic follows git's convention: the username is ignored and the
 * password field carries the token — exactly how git credential helpers
 * and `https://x:gs_...@host/o/r.git` remotes present it (RFC 7617 §2:
 * only the first colon separates user-id from password).
 *
 * Used by the raw git wire routes in the Worker and forwarded to the Repo
 * DO; REST routes get the same parse via {@link GitAuthLive}. Returns
 * `undefined` when the header is absent or unparseable — the caller
 * answers `401` + `WWW-Authenticate: Basic realm="git-service"` so the
 * git client retries with credentials.
 *
 * Pure string/base64 work — no I/O, no platform APIs.
 */
export const parseBasicOrBearer = (
  headers: Readonly<Record<string, string | undefined>>,
): ParsedCredentials | undefined => {
  const parsed = parseAuthorization(headers.authorization);
  if (parsed === undefined) return undefined;
  switch (parsed.scheme) {
    case "bearer":
      return { token: Redacted.make(parsed.credential) };
    case "basic": {
      const decoded = Result.getOrUndefined(
        Encoding.decodeBase64String(parsed.credential),
      );
      if (decoded === undefined) return undefined;
      // RFC 7617, Section 2: only the first colon separates the
      // user-id from the password.
      const separator = decoded.indexOf(":");
      if (separator === -1) return undefined;
      return { token: Redacted.make(decoded.slice(separator + 1)) };
    }
    default:
      return undefined;
  }
};

/**
 * Live implementation of the `GitAuth` security middleware.
 *
 * Follows `StateAuthLive` (packages/alchemy/src/State/HttpStateApi.ts):
 * one handler per security scheme, each wrapping the endpoint effect with
 * a `Credentials` provision. Parsing only — token/scope enforcement
 * happens in the Repo DO, which owns the tokens table.
 *
 * The HttpApi security decoder yields an *empty* credential (rather than
 * failing) when the `Authorization` header is missing or carries a
 * different scheme, so each handler fails `Unauthorized` on an empty
 * secret — that failure makes the dispatcher fall through to the next
 * scheme, and a request with no usable credential at all surfaces as a
 * typed 401.
 */
export const GitAuthLive: Layer.Layer<GitAuth> = Layer.succeed(GitAuth, {
  bearer: (httpEffect, { credential }) =>
    Redacted.value(credential) === ""
      ? // Fail so the dispatcher falls through to `basic` (a Basic header
        // decodes as an empty bearer credential).
        Effect.fail(new Unauthorized())
      : Effect.provideService(httpEffect, Credentials, { token: credential }),
  basic: (httpEffect, { credential }) =>
    Redacted.value(credential.password) === ""
      ? // Last scheme: no usable credential anywhere means the request is
        // ANONYMOUS, not rejected — public repos allow tokenless reads.
        // Enforcement stays in the Repo DO, which knows the repo's
        // visibility; endpoints that need auth fail there with 401/403.
        Effect.provideService(httpEffect, Credentials, { token: undefined })
      : Effect.provideService(httpEffect, Credentials, {
          // git convention: username ignored, password carries the token.
          token: credential.password,
        }),
});

/** Sync sha-256 digest of a UTF-8 string (pure CPU, node:crypto). */
const sha256 = (input: string): Uint8Array => {
  const digest = crypto.createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
};

/**
 * Timing-safe string equality for secret comparison (the admin key).
 *
 * Both inputs are normalized to their sha-256 digests first — equal
 * length by construction, so no length information leaks and the compare
 * is a single constant-time `crypto.subtle.timingSafeEqual` (a Cloudflare
 * Workers extension of SubtleCrypto; see
 * packages/alchemy/src/Cloudflare/StateStore/Api.ts).
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
export const timingSafeEqual = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.sync(() => {
    const aDigest = sha256(a);
    const bDigest = sha256(b);
    // @ts-expect-error — timingSafeEqual is a Cloudflare Workers extension
    // of SubtleCrypto (not in the standard lib types).
    return crypto.subtle.timingSafeEqual(aDigest, bDigest) as boolean;
  });

/**
 * Verifies a presented credential against the deployer admin key
 * (`GIT_SERVICE_ADMIN_TOKEN`) with a timing-safe compare. Inputs are
 * trimmed so a trailing newline in a pasted secret never causes an
 * infuriating mismatch.
 *
 * The admin key grants: repo create/update/delete/list-all, fork/import,
 * and implicit `admin` scope on every repo (DESIGN.md §8).
 */
export const verifyAdminKey = (
  candidate: Redacted.Redacted<string>,
  adminKey: Redacted.Redacted<string>,
): Effect.Effect<boolean> =>
  timingSafeEqual(
    Redacted.value(candidate).trim(),
    Redacted.value(adminKey).trim(),
  );

/**
 * Mints a fresh per-repo token secret: `gs_` + base64url of 32 random
 * bytes (~256 bits of entropy). The secret is returned to the caller
 * exactly once; only {@link hashToken} of it is persisted in the repo
 * DO's `tokens` table.
 */
export const mintToken: Effect.Effect<string> = Effect.sync(
  () => `${TOKEN_PREFIX}${crypto.randomBytes(32).toString("base64url")}`,
);

/**
 * Hex sha-256 of a token secret — the storage/lookup key in the repo DO's
 * `tokens` table (`token_hash` column). High-entropy input makes the
 * indexed hash lookup non-timing-sensitive.
 */
export const hashToken = (token: string): Effect.Effect<string> =>
  Effect.sync(() => crypto.createHash("sha256").update(token).digest("hex"));
