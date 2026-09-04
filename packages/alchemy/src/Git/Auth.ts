/**
 * Who is calling, and may they do this. The git engine holds no
 * credentials and no users: authentication happens outside it, in the
 * HTTP middleware you own, and the engine asks one pure question about
 * each action.
 *
 * - {@link Principal} is the identity your authentication resolved.
 * - {@link Caller} is the service the middleware provides to every route:
 *   a principal, or anonymous.
 * - {@link Authenticated} is the middleware contract every git route
 *   declares. Implement it once, for browsers and `git` clients alike; the
 *   engine ships {@link AuthenticatedSecret}, one shared secret for one
 *   principal.
 * - {@link Policy} answers yes or no for a principal, a repository, and a
 *   {@link GitAction}. It runs where the action's facts are parsed: a push
 *   is judged inside the repository's Durable Object with the refs it
 *   wants to move. {@link PolicyOwners} is the default.
 */
import { Random } from "../Random.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import crypto from "node:crypto";
import { Unauthorized } from "./Api/Schema.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The identity your authentication resolved. `id` is what repositories are
 * owned by: owner names are lowercased, so a repository is a principal's
 * when `repo.owner === principal.id.toLowerCase()` ({@link owns}).
 */
export interface Principal {
  readonly id: string;
  /** Display name, if your identity system has one. */
  readonly name?: string | undefined;
}

/** The wire form of {@link Principal}, for endpoints that return it. */
export const PrincipalSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.String),
});

/**
 * The caller of a request, as the {@link Authenticated} middleware
 * provided it: a {@link Principal}, or `undefined` for an anonymous
 * request. Anonymous is not a failure; the policy decides what anonymous
 * may do.
 */
export class Caller extends Context.Service<
  Caller,
  { readonly principal: Principal | undefined }
>()("alchemy/Git/Caller") {}

/** Request headers, as Effect's HTTP server exposes them. */
export type Headers = Readonly<Record<string, string | undefined>>;

/**
 * Resolves the caller of the current request, read from
 * `HttpServerRequest`. Runs at the Worker, once per request, before every
 * git route: the REST plane, the git wire (a `git` client sends HTTP Basic
 * with the credential in the password field), the raw reads, and the
 * GitHub facade. `undefined` is anonymous, never a failure.
 */
export type Resolve = Effect.Effect<
  Principal | undefined,
  never,
  HttpServerRequest.HttpServerRequest | RuntimeContext
>;

/**
 * The middleware contract every git route declares: it provides
 * {@link Caller}. Implement it with `Authenticated.make`, which takes an
 * Effect that produces the per-request {@link Resolve}: declare the
 * resources, bindings, and services the resolver needs there.
 *
 * **Example:** Better Auth sessions for browsers, API keys for `git`
 * ```typescript
 * const AuthenticatedLive = Git.Authenticated.make(
 *   Effect.gen(function* () {
 *     const auth = yield* Auth;
 *     return Effect.gen(function* () {
 *       const request = yield* HttpServerRequest;
 *       const key = Git.parseSecret(request.headers);
 *       if (key !== undefined) {
 *         const verified = yield* auth.api.verifyApiKey({ body: { key } });
 *         return verified.valid && verified.key ? { id: verified.key.referenceId } : undefined;
 *       }
 *       const session = yield* auth.getSession();
 *       return session ? { id: session.user.id, name: session.user.name } : undefined;
 *     });
 *   }),
 * );
 * ```
 *
 * @binding
 */
export class Authenticated extends HttpApiMiddleware.Service<
  Authenticated,
  { provides: Caller }
>()("alchemy/Git/Authenticated", { error: Unauthorized }) {
  /**
   * An implementation of the middleware as a Layer. `init` runs once, when
   * the layer is built, and produces the per-request {@link Resolve}.
   */
  static readonly make = <E, R>(
    init: Effect.Effect<Resolve, E, R>,
  ): Layer.Layer<Authenticated, E, R> =>
    Layer.effect(
      Authenticated,
      Effect.map(
        init,
        (resolve) => (httpEffect) =>
          Effect.gen(function* () {
            const principal = yield* resolve.pipe(
              Effect.provide(RuntimeContext.phantom),
            );
            return yield* Effect.provideService(httpEffect, Caller, {
              principal,
            });
          }),
      ),
    );
}

/** The caller of the current request, anonymous when no middleware provided one. */
export const currentCaller: Effect.Effect<Principal | undefined> = Effect.map(
  Effect.serviceOption(Caller),
  (caller) => (Option.isSome(caller) ? caller.value.principal : undefined),
);

// ─────────────────────────────────────────────────────────────────────────────
// Actions and policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One ref a push wants to move: `oldOid` is the expected current value
 * (all-zeros for a create), `newOid` the target (all-zeros for a delete).
 */
export interface RefUpdate {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/**
 * What the caller is attempting, in git's own vocabulary. A policy answers
 * yes or no per action; no role ladder is imposed.
 */
export type GitAction =
  /** Wire reads: the ref advertisement and `git-upload-pack`. */
  | { readonly _tag: "Fetch" }
  /**
   * Wire writes: `git-receive-pack` and the REST ref writes. `updates`
   * carries the parsed ref commands: empty at the advertisement (may this
   * caller push at all?), exact at commit.
   */
  | { readonly _tag: "Push"; readonly updates: ReadonlyArray<RefUpdate> }
  /** REST reads: repository metadata, refs, objects, log, diffs, pulls. */
  | { readonly _tag: "ReadRepo" }
  /** Mutating repository settings: description, default branch, visibility. */
  | { readonly _tag: "UpdateRepo" }
  | { readonly _tag: "DeleteRepo" }
  /** Creating a repository under `owner`; also fork and import. */
  | { readonly _tag: "CreateRepo"; readonly owner: string }
  /** Listing every repository including private ones. */
  | { readonly _tag: "ListRepos" }
  /** Operator maintenance: compaction, purge. */
  | { readonly _tag: "Maintain" }
  | {
      readonly _tag: "CreatePull";
      readonly base: string;
      readonly head: string;
    }
  | { readonly _tag: "UpdatePull"; readonly number: number }
  | { readonly _tag: "MergePull"; readonly number: number };

/** `Fetch` and `ReadRepo`: the actions a public repository grants anyone. */
export const isReadAction = (action: GitAction): boolean =>
  action._tag === "Fetch" || action._tag === "ReadRepo";

/** Repository state a policy can key on, supplied by the engine. */
export interface RepoContext {
  readonly repoId: string;
  readonly owner: string;
  readonly name: string;
  /** Anyone may read and clone without a credential when `true`. */
  readonly public: boolean;
  readonly defaultBranch: string;
  readonly readOnly: boolean;
}

export interface PolicyShape {
  /**
   * May this principal (or anonymous caller) perform this action? `repo` is
   * `null` for registry-level actions (`CreateRepo`, `ListRepos`). Must be
   * a fast, pure decision over its inputs: it sits on the wire hot path
   * inside the Durable Object.
   */
  readonly authorize: (input: {
    readonly principal: Principal | undefined;
    readonly repo: RepoContext | null;
    readonly action: GitAction;
  }) => Effect.Effect<boolean, never, RuntimeContext>;
}

/**
 * The one auth-shaped thing inside the engine, and it never sees a
 * credential: yes or no for a principal, a repository, and an action.
 *
 * **Example:** direct pushes to `main` only by the repository's owner
 * ```typescript
 * const AppPolicy = Layer.succeed(Git.Policy, {
 *   authorize: ({ principal, repo, action }) =>
 *     Effect.succeed(
 *       principal === undefined
 *         ? repo?.public === true && Git.isReadAction(action)
 *         : action._tag === "Push"
 *           ? action.updates.every((u) =>
 *               u.ref === "refs/heads/main" ? repo?.owner === principal.id : true,
 *             )
 *           : repo?.owner === principal.id || (repo?.public === true && Git.isReadAction(action)),
 *     ),
 * });
 * ```
 *
 * @binding
 */
export class Policy extends Context.Service<Policy, PolicyShape>()(
  "alchemy/Git/Policy",
) {}

/**
 * The default policy. Anonymous callers read public repositories. A
 * principal may create repositories, list everything, read public ones,
 * and do anything to repositories it owns (`repo.owner === principal.id`).
 *
 * @layer
 * @provides Git.Policy
 */
export const PolicyOwners: Layer.Layer<Policy> = Layer.succeed(Policy, {
  authorize: ({ principal, repo, action }) =>
    Effect.succeed(
      principal === undefined
        ? repo !== null && repo.public && isReadAction(action)
        : repo === null
          ? true
          : owns(principal, repo) || (repo.public && isReadAction(action)),
    ),
});

/** Owner names are lowercased by the engine; a principal's id need not be. */
export const owns = (principal: Principal, repo: RepoContext): boolean =>
  repo.owner === principal.id.toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// Header parsing
// ─────────────────────────────────────────────────────────────────────────────

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
 * HTTP Basic credentials from the `Authorization` header. A `git` client
 * puts the token in the password field and ignores the username, which is
 * how `https://x:TOKEN@host/owner/repo.git` remotes work.
 */
export const parseBasic = (
  headers: Headers,
): { readonly username: string; readonly password: string } | undefined => {
  const parsed = parseAuthorization(headers.authorization);
  if (parsed === undefined || parsed.scheme !== "basic") return undefined;
  const decoded = Result.getOrUndefined(
    Encoding.decodeBase64String(parsed.credential),
  );
  if (decoded === undefined) return undefined;
  // RFC 7617, Section 2: only the first colon separates the user-id from
  // the password.
  const separator = decoded.indexOf(":");
  if (separator === -1) return undefined;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
};

/**
 * A `Bearer` credential from the `Authorization` header. GitHub's legacy
 * `token` scheme, which `gh` and Octokit send, is accepted as the same.
 */
export const parseBearer = (headers: Headers): string | undefined => {
  const parsed = parseAuthorization(headers.authorization);
  if (parsed === undefined) return undefined;
  return parsed.scheme === "bearer" || parsed.scheme === "token"
    ? parsed.credential
    : undefined;
};

/** Bearer, `token`, or the Basic password: the one secret a request carries. */
export const parseSecret = (headers: Headers): string | undefined =>
  parseBearer(headers) ?? parseBasic(headers)?.password;

/** Sync sha-256 digest of a UTF-8 string (pure CPU, node:crypto). */
const sha256 = (input: string): Uint8Array => {
  const digest = crypto.createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
};

/**
 * Timing-safe string equality for secret comparison. Both inputs are
 * normalized to their sha-256 digests first, so the compare is one
 * constant-time `crypto.subtle.timingSafeEqual` over equal lengths.
 */
export const timingSafeEqual = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.sync(() => crypto.timingSafeEqual(sha256(a), sha256(b)));

// ─────────────────────────────────────────────────────────────────────────────
// Shipped implementation
// ─────────────────────────────────────────────────────────────────────────────

/** The id of the `Alchemy.Random` {@link AuthenticatedSecret} declares when none is passed. */
export const SECRET_RESOURCE_ID = "GitServiceSecret" as const;

/**
 * One shared secret, one principal: the smallest thing that secures a
 * fresh host. The secret is an `Alchemy.Random`, minted on the first
 * deploy, stable across deploys, and bound to the Worker; a request that
 * presents it (Bearer, or the Basic password a `git` client sends) is
 * `principal`, anything else is anonymous.
 *
 * Declare the `Random` yourself to read it back from the stack:
 *
 * **Example:** the starter host
 * ```typescript
 * export const GitSecret = Alchemy.Random("GitSecret");
 *
 * // whoever presents the secret is "acme", and acme/web is theirs
 * Layer.provide(Git.AuthenticatedSecret({ principal: "acme", secret: GitSecret }))
 *
 * // alchemy.run.ts
 * const secret = yield* GitSecret;
 * return { url: git.url.as<string>(), secret: Output.map(secret.text, Redacted.value) };
 * ```
 *
 * @layer
 * @provides Git.Authenticated
 */
export const AuthenticatedSecret = (options: {
  /**
   * Who a request presenting the secret is acting as. A string is the
   * principal's id, which is the owner name of the repositories it
   * creates: `"acme"` owns `acme/web`.
   */
  readonly principal: string | Principal;
  /**
   * The `Alchemy.Random` holding the secret. Declared for you as
   * {@link SECRET_RESOURCE_ID} when omitted.
   */
  readonly secret?: Effect.Effect<Random, never, any> | undefined;
}): Layer.Layer<Authenticated> =>
  Authenticated.make(
    Effect.gen(function* () {
      const principal: Principal =
        typeof options.principal === "string"
          ? { id: options.principal }
          : options.principal;
      // Yielding the resource class gives a constructor whose providers are
      // the host stack's, so declaring the secret here needs nothing from
      // the caller. A user-declared Random is the same resource, yielded.
      const resource =
        options.secret === undefined
          ? yield* (yield* Random)(SECRET_RESOURCE_ID)
          : yield* options.secret as Effect.Effect<Random>;
      // Yielded at build time, the attribute is a runtime accessor over the
      // value bound onto the Worker.
      const secret = yield* resource.text;
      return Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = parseSecret(request.headers);
        if (presented === undefined || presented === "") return undefined;
        const matches = yield* timingSafeEqual(
          presented,
          Redacted.value(yield* secret),
        );
        return matches ? principal : undefined;
      });
    }),
  );
