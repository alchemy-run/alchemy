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
import type { RuntimeContext } from "../RuntimeContext.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import crypto from "node:crypto";
import { Credentials, GitAuth, Unauthorized } from "./Api.ts";
import type { TokenScope } from "./api/Schema.ts";

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
    // `token` is GitHub's legacy scheme — what `gh` and Octokit send to
    // GitHub Enterprise hosts. Same semantics as Bearer.
    case "token":
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
  () =>
    // `Encoding.encodeBase64Url` rather than Buffer's "base64url": the
    // digest is a plain Uint8Array here, and this stays correct on
    // workerd where Buffer is a shim.
    `${TOKEN_PREFIX}${Encoding.encodeBase64Url(crypto.randomBytes(32))}`,
);

/**
 * Hex sha-256 of a token secret — the storage/lookup key in the repo DO's
 * `tokens` table (`token_hash` column). High-entropy input makes the
 * indexed hash lookup non-timing-sensitive.
 */
export const hashToken = (token: string): Effect.Effect<string> =>
  Effect.sync(() => crypto.createHash("sha256").update(token).digest("hex"));

// ─────────────────────────────────────────────────────────────────────────────
// The Auth contract (RFC "Git Building Blocks" §3.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Config key of the deployer admin secret. Resolved at deploy time
 * from the deployer's environment and bound onto the Worker as a secret;
 * grants repo create/update/delete/list-all, fork/import, and every
 * per-repo action (DESIGN.md §8).
 */
export const ADMIN_TOKEN_CONFIG_KEY = "GIT_SERVICE_ADMIN_TOKEN" as const;

/**
 * One ref a push wants to move: `oldOid` is the expected current value
 * (all-zeros for a create), `newOid` the target (all-zeros for a delete).
 * The engine parses these from the receive-pack command list and hands
 * them to {@link Auth}'s `authorize` inside the `Push` action — which is
 * what makes per-branch rules (protected `main`, tag policies)
 * expressible by implementations.
 */
export interface RefUpdate {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/**
 * What the caller is attempting, in the engine's own vocabulary — parsed
 * protocol facts, not roles. Implementations answer yes/no per action;
 * no scope ladder is imposed by the contract (the default
 * {@link AuthTokens} keeps its `read|write|admin` ladder internal).
 */
export type GitAction =
  /** Wire reads: ref advertisement + `git-upload-pack` (clone/fetch). */
  | { readonly _tag: "Fetch" }
  /**
   * Wire writes: `git-receive-pack` and the REST ref-write endpoints.
   * `updates` carries the parsed ref commands — empty at the
   * advertisement stage (the refs are not known yet), exact at commit
   * time, so implementations should treat an empty list as "may this
   * caller push at all?".
   */
  | { readonly _tag: "Push"; readonly updates: ReadonlyArray<RefUpdate> }
  /** REST reads: repo meta, refs, objects, log, diffs, files, pulls. */
  | { readonly _tag: "ReadRepo" }
  /** Mutating repo settings: description, default branch, visibility. */
  | { readonly _tag: "UpdateRepo" }
  | { readonly _tag: "DeleteRepo" }
  /** Creating a repo under `owner` — also covers fork and import. */
  | { readonly _tag: "CreateRepo"; readonly owner: string }
  /** Listing every repo including private ones (`GET /repos`). */
  | { readonly _tag: "ListRepos" }
  /** Minting, listing, or revoking this repo's access tokens. */
  | { readonly _tag: "ManageTokens" }
  /** Operator maintenance: triggering compaction or purge. */
  | { readonly _tag: "Maintain" }
  | {
      readonly _tag: "CreatePull";
      readonly base: string;
      readonly head: string;
    }
  | { readonly _tag: "UpdatePull"; readonly number: number }
  | { readonly _tag: "MergePull"; readonly number: number };

/**
 * Who is calling — produced by {@link Auth}'s `authenticate` at the
 * Worker and forwarded to the Repo DO over the trusted internal channel
 * (the DO trusts identity, never re-derives it; inbound impersonation is
 * stripped, same discipline as the wire `ADMIN_HEADER`).
 *
 * - `admin` — the deployer admin key, verified timing-safe at the Worker.
 * - `token` — an opaque repo-token secret. The engine enriches it with
 *   the token's `scope` (from the repo DO's tokens table) before calling
 *   `authorize`; a token that fails verification never reaches it.
 * - `user` — an external identity (e.g. a Better Auth session or API
 *   key), resolved entirely by the {@link Auth} implementation.
 * - `anonymous` — no credential presented.
 */
export type Actor =
  | { readonly kind: "admin" }
  | {
      readonly kind: "token";
      readonly token: string;
      /** Filled in by the engine (tokens-table lookup) before `authorize`. */
      readonly scope?: TokenScope | undefined;
    }
  | {
      readonly kind: "user";
      readonly id: string;
      readonly name?: string | undefined;
      readonly email?: string | undefined;
    }
  | { readonly kind: "anonymous" };

/**
 * Repo state the engine supplies to `authorize` — everything a policy
 * can reasonably key on, and nothing that requires I/O to check.
 */
export interface RepoContext {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  /** Anyone can read/clone without a credential when `true`. */
  readonly public: boolean;
  readonly defaultBranch: string;
  readonly readOnly: boolean;
}

/** The service shape — see {@link Auth}. */
export interface AuthShape {
  /**
   * AUTHENTICATION: who is calling? Runs at the Worker, once per
   * request. Never fails closed — an absent or unparseable credential is
   * the `anonymous` actor, and endpoints that need auth deny it in
   * `authorize`.
   */
  readonly authenticate: (
    headers: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<Actor, never, RuntimeContext>;
  /**
   * AUTHORIZATION: may this actor perform this action? Runs at the site
   * that owns the action's facts — the Worker for registry-level actions
   * (`repo` is `null` there: CreateRepo, ListRepos), the Repo DO for
   * everything per-repo, including the post-parse `Push` with the real
   * ref updates. Must be a fast, pure decision over its inputs: it sits
   * on the wire hot path inside the DO.
   */
  readonly authorize: (input: {
    readonly actor: Actor;
    readonly repo: RepoContext | null;
    readonly action: GitAction;
  }) => Effect.Effect<boolean, never, RuntimeContext>;
}

/**
 * The swappable authentication + authorization block of the git service
 * (RFC §3.2). The engine asks domain-specific questions ({@link GitAction})
 * and the implementation answers yes/no — no imposed role vocabulary.
 *
 * Implementations shipped:
 *
 * - {@link AuthTokens} — the default: deployer admin key + per-repo
 *   scoped tokens (`read|write|admin`), anonymous read on public repos.
 *
 * @binding
 */
export class Auth extends Context.Service<Auth, AuthShape>()(
  "alchemy/Git/Auth",
) {}

// ─────────────────────────────────────────────────────────────────────────────
// AuthTokens — the default implementation
// ─────────────────────────────────────────────────────────────────────────────

/** The default ladder's ordering — internal to {@link AuthTokens}. */
export const SCOPE_RANK: Record<TokenScope, number> = {
  read: 0,
  write: 1,
  admin: 2,
};

/**
 * The scope {@link AuthTokens} demands for each action — exported so the
 * engine can label `Forbidden` errors with the conventional scope name,
 * but semantically private to the default implementation: other `Auth`
 * implementations need no notion of scopes at all.
 */
export const requiredScope = (action: GitAction): TokenScope => {
  switch (action._tag) {
    case "Fetch":
    case "ReadRepo":
      return "read";
    case "Push":
    case "CreatePull":
    case "UpdatePull":
    case "MergePull":
      return "write";
    default:
      return "admin";
  }
};

/**
 * The default `Auth`: deployer admin key + per-repo scoped tokens.
 *
 * - `authenticate` parses Bearer/Basic/`token` headers and verifies the
 *   admin key timing-safe; everything else is an opaque `token` actor
 *   (verified later by the repo DO, which owns the tokens table).
 * - `authorize` is the old scope ladder, now internal: admin passes
 *   everything, tokens need `read|write|admin` rank per action, and
 *   anonymous callers get read-only actions on public repos — the
 *   GitHub model.
 *
 * @layer
 * @provides Git.Auth
 */
export const AuthTokens: Layer.Layer<Auth> = Layer.effect(
  Auth,
  Effect.gen(function* () {
    // A missing admin secret is a misconfigured deploy — die at layer
    // build (Worker init), never at request time.
    const adminKey = yield* Config.redacted(ADMIN_TOKEN_CONFIG_KEY).pipe(
      Effect.orDie,
    );
    return {
      authenticate: (headers) =>
        Effect.gen(function* () {
          const parsed = parseBasicOrBearer(headers);
          if (parsed === undefined) return { kind: "anonymous" } as const;
          const isAdmin = yield* verifyAdminKey(parsed.token, adminKey);
          return isAdmin
            ? ({ kind: "admin" } as const)
            : ({
                kind: "token",
                token: Redacted.value(parsed.token),
              } as const);
        }),
      authorize: ({ actor, repo, action }) =>
        Effect.succeed(
          actor.kind === "admin"
            ? true
            : actor.kind === "token"
              ? actor.scope !== undefined &&
                SCOPE_RANK[actor.scope] >= SCOPE_RANK[requiredScope(action)]
              : actor.kind === "anonymous"
                ? repo?.public === true && requiredScope(action) === "read"
                : // `user` actors are not this implementation's model —
                  // external identities belong to adapter layers.
                  false,
        ),
    } satisfies AuthShape;
  }),
);
