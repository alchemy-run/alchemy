/**
 * The typed REST contract for git-service (DESIGN.md §5).
 *
 * Everything on the management plane — repos, refs, objects, tokens — is
 * declared here as an Effect `HttpApi` so that the Worker, the Repo DO
 * handlers, and test clients (`HttpApiClient.make(GitApi, ...)`) all share
 * one schema-checked surface. The git wire protocol
 * (`/:owner/:repo.git/info/refs`, `git-upload-pack`, `git-receive-pack`)
 * and the raw streaming blob/file reads are deliberately NOT part of this
 * contract — they are registered as raw `HttpRouter` routes on the same
 * router (see `GitWorker.ts`), keeping binary streaming out of schema land.
 *
 * Auth model (DESIGN.md §8): the `GitAuth` middleware only *parses*
 * credentials (Basic password or Bearer token) into the `Credentials`
 * service; enforcement happens in the Repo DO, which owns the tokens table.
 */
import * as Context from "effect/Context";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as HttpApiSecurity from "effect/unstable/httpapi/HttpApiSecurity";

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A 40-hex SHA-1 object id, branded so oids never mix with plain strings.
 * Widening to SHA-256 later is mechanical because every consumer goes
 * through this schema (DESIGN.md §1 "Hashing").
 */
export const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)).pipe(
  Schema.brand("Oid"),
);

/** The decoded (branded) type of {@link Oid}. */
export type Oid = typeof Oid.Type;

/**
 * A repository name: 1–100 chars, alphanumeric with `._-` separators,
 * must start and end alphanumeric. Case-insensitive match, stored as given.
 */
export const RepoName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/i),
);

/**
 * An owner (namespace) name. Same grammar as {@link RepoName}. The literal
 * owner `api` is reserved (rejected by the Registry at creation) so the
 * `/api/v1` prefix can never collide with a repo URL.
 */
export const OwnerName = RepoName;

/**
 * A full ref name (`refs/heads/main`, `refs/tags/v1.0`). Rejects the
 * whitespace / `~^:?*[\` characters git itself forbids. HEAD is virtual
 * (symref to the default branch) and is never a valid `RefName` here.
 */
export const RefName = Schema.String.check(
  Schema.isPattern(/^refs\/[^\s~^:?*\[\\]+$/),
);

/**
 * Access scope carried by a per-repo token (DESIGN.md §8):
 * - `read` — advertisement + upload-pack + all REST reads
 * - `write` — read + receive-pack + REST ref writes (subject to `readOnly`)
 * - `admin` — write + token create/list/revoke + repo update/delete
 */
export const TokenScope = Schema.Literals(["read", "write", "admin"]);

/** The decoded type of {@link TokenScope}. */
export type TokenScope = typeof TokenScope.Type;

/**
 * Lifecycle status of a repo. Async operations (import/fork/delete) flip
 * this field; clients poll `GET /repos/:owner/:repo` until `ready` (or 404
 * once a `deleting` repo's purge completes). There is no jobs API.
 */
export const RepoStatus = Schema.Literals([
  "ready",
  "importing",
  "forking",
  "deleting",
]);

/** The decoded type of {@link RepoStatus}. */
export type RepoStatus = typeof RepoStatus.Type;

// ─────────────────────────────────────────────────────────────────────────────
// Error taxonomy (tagged, status-annotated)
// ─────────────────────────────────────────────────────────────────────────────

/** 401 — missing or invalid credentials. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/** 403 — the presented token lacks the required scope. */
export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { required: TokenScope },
  { httpApiStatus: 403 },
) {}

/** 403 — the repo is flagged `readOnly`; writes are rejected. */
export class ReadOnlyRepo extends Schema.TaggedError<ReadOnlyRepo>()(
  "ReadOnlyRepo",
  {},
  { httpApiStatus: 403 },
) {}

/** 404 — no repo at `owner/repo` (or it finished deleting). */
export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()(
  "RepoNotFound",
  { owner: Schema.String, repo: Schema.String },
  { httpApiStatus: 404 },
) {}

/** 409 — a repo already exists at `owner/repo`. */
export class RepoAlreadyExists extends Schema.TaggedError<RepoAlreadyExists>()(
  "RepoAlreadyExists",
  { owner: Schema.String, repo: Schema.String },
  { httpApiStatus: 409 },
) {}

/**
 * 409 — the repo exists but is not `ready` (importing / forking /
 * deleting); retry after polling `GET /repos/:owner/:repo`.
 */
export class RepoNotReady extends Schema.TaggedError<RepoNotReady>()(
  "RepoNotReady",
  { status: RepoStatus },
  { httpApiStatus: 409 },
) {}

/** 404 — the named ref does not exist. */
export class RefNotFound extends Schema.TaggedError<RefNotFound>()(
  "RefNotFound",
  { ref: Schema.String },
  { httpApiStatus: 404 },
) {}

/**
 * 409 — compare-and-swap failure on a ref write: `expectedOid` did not
 * match the ref's current value (`currentOid`, `null` when the ref does
 * not exist).
 */
export class RefConflict extends Schema.TaggedError<RefConflict>()(
  "RefConflict",
  { ref: Schema.String, currentOid: Schema.NullOr(Oid) },
  { httpApiStatus: 409 },
) {}

/** 404 — no object with the given oid in this repo. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()(
  "ObjectNotFound",
  { oid: Schema.String },
  { httpApiStatus: 404 },
) {}

/** 422 — the object exists but has a different type than the endpoint expects. */
export class WrongObjectType extends Schema.TaggedError<WrongObjectType>()(
  "WrongObjectType",
  { oid: Schema.String, expected: Schema.String, actual: Schema.String },
  { httpApiStatus: 422 },
) {}

/**
 * 422 — the blob is too large for the base64 JSON endpoint (> 1 MiB);
 * use the raw streaming route `GET .../blobs/:oid/raw` instead.
 */
export class ObjectTooLarge extends Schema.TaggedError<ObjectTooLarge>()(
  "ObjectTooLarge",
  { oid: Schema.String, size: Schema.Number },
  { httpApiStatus: 422 },
) {}

/** 404 — no token with the given id on this repo. */
export class TokenNotFound extends Schema.TaggedError<TokenNotFound>()(
  "TokenNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

/** 502 — the async import job failed against the source remote. */
export class ImportFailed extends Schema.TaggedError<ImportFailed>()(
  "ImportFailed",
  { reason: Schema.String },
  { httpApiStatus: 502 },
) {}

/** 400 — semantically invalid request (e.g. reserved owner name). */
export class ValidationError extends Schema.TaggedError<ValidationError>()(
  "ValidationError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

// ─────────────────────────────────────────────────────────────────────────────
// Auth middleware
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The parsed request credential — a repo token (`gs_...`) or the admin key.
 *
 * Provided to every authenticated endpoint by the {@link GitAuth}
 * middleware. Handlers forward it to Repo-DO RPCs, which are the
 * enforcement point (the DO owns the tokens table; the Worker only
 * verifies the admin key). This service boundary is also the v2 identity
 * seam: an OAuth-fronting worker can provide `Credentials` without
 * touching DO enforcement code (DESIGN.md §8).
 */
export class Credentials extends Context.Service<
  Credentials,
  {
    /** The raw secret presented by the client (repo token or admin key). */
    readonly token: Redacted.Redacted<string>;
  }
>()("git-service/Credentials") {}

/**
 * Security middleware for every REST group: accepts `Authorization:
 * Bearer <token>` or HTTP Basic (username ignored, password = token —
 * exactly how git credential helpers and `https://x:gs_...@host` remotes
 * present it), and provides {@link Credentials} to the endpoint handlers.
 *
 * Parsing only — no verification here. Missing/unparseable credentials
 * fail with {@link Unauthorized} (401). The live implementation is
 * `GitAuthLive` in `Auth.ts`.
 */
export class GitAuth extends HttpApiMiddleware.Service<
  GitAuth,
  { provides: Credentials }
>()("git-service/GitAuth", {
  security: {
    bearer: HttpApiSecurity.bearer,
    basic: HttpApiSecurity.basic,
  },
  error: Unauthorized,
}) {}

// ─────────────────────────────────────────────────────────────────────────────
// Domain shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A repository resource as returned by the management plane.
 */
export class Repo extends Schema.Class<Repo>("Repo")({
  /** Owner (namespace) segment of the repo's URL. */
  owner: OwnerName,
  /** Repo name segment of the repo's URL. */
  name: RepoName,
  /**
   * The stable ULID identity of the repo. Renames never move data because
   * the Repo DO id derives from `repoId`, not `owner/name`.
   */
  repoId: Schema.String,
  /** Short branch name (e.g. `main`) that HEAD symrefs to. */
  defaultBranch: Schema.String,
  /** Optional human description. */
  description: Schema.NullOr(Schema.String),
  /** When `true`, receive-pack and REST ref writes are rejected. */
  readOnly: Schema.Boolean,
  /** Parent `repoId` when this repo is a fork, else `null`. */
  forkOf: Schema.NullOr(Schema.String),
  /** Lifecycle status; poll this for async fork/import/delete progress. */
  status: RepoStatus,
  /** Creation time, epoch milliseconds. */
  createdAt: Schema.Number,
}) {}

/**
 * A ref (branch or tag). `peeled` carries the target commit for annotated
 * tags (the advertisement's `^{}` line).
 */
export class Ref extends Schema.Class<Ref>("Ref")({
  /** Full ref name, e.g. `refs/heads/main`. */
  name: RefName,
  /** The object the ref points at. */
  oid: Oid,
  /** For annotated tags: the peeled (commit) oid. */
  peeled: Schema.optional(Oid),
}) {}

/** An author/committer/tagger signature line. */
const Signature = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
  /** Unix timestamp (seconds). */
  date: Schema.Number,
  /** Timezone offset as written, e.g. `+0200`. */
  tz: Schema.String,
});

/** Parsed commit metadata for the REST read surface. */
export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
  oid: Oid,
  /** Root tree of the commit. */
  tree: Oid,
  /** Parent commit oids in order. */
  parents: Schema.Array(Oid),
  author: Signature,
  committer: Signature,
  /** Full commit message (verbatim, including trailing newline). */
  message: Schema.String,
}) {}

/** A single tree entry. `commit` type = gitlink (submodule). */
export class TreeEntry extends Schema.Class<TreeEntry>("TreeEntry")({
  /** Octal mode string as stored, e.g. `100644`, `40000`, `120000`. */
  mode: Schema.String,
  /** Entry name (single path segment). */
  name: Schema.String,
  oid: Oid,
  /** Entry kind derived from mode. */
  type: Schema.Literals(["blob", "tree", "commit"]),
}) {}

/** Metadata of a per-repo access token (the secret itself is never listed). */
export class TokenInfo extends Schema.Class<TokenInfo>("TokenInfo")({
  /** Token id (ULID) — used for revocation. */
  id: Schema.String,
  /** Human-readable label. */
  name: Schema.String,
  scope: TokenScope,
  /** Creation time, epoch milliseconds. */
  createdAt: Schema.Number,
  /** Expiry time (epoch milliseconds), `null` = no expiry. */
  expiresAt: Schema.NullOr(Schema.Number),
  /** Last verified use (epoch milliseconds, hourly granularity), `null` = never. */
  lastUsedAt: Schema.NullOr(Schema.Number),
}) {}

/**
 * A freshly minted token: {@link TokenInfo} plus the secret value, shown
 * exactly once. Only the sha-256 hash is stored server-side.
 */
export class CreatedToken extends TokenInfo.extend<CreatedToken>(
  "CreatedToken",
)({
  /** The `gs_...` secret. Shown exactly once — store it now. */
  token: Schema.String,
}) {}

/**
 * Response of repo create/fork/import: the repo plus a ready-to-use HTTPS
 * remote URL and a bootstrap `write` token, killing the create-then-mint
 * round trip.
 */
export class RepoCreated extends Schema.Class<RepoCreated>("RepoCreated")({
  repo: Repo,
  /** HTTPS clone URL for the new repo. */
  remote: Schema.String,
  /** Bootstrap `write` token (shown exactly once). */
  token: CreatedToken,
}) {}

/**
 * Cursor-paginated wrapper used by list endpoints.
 *
 * @example
 * ```typescript
 * const page = Paginated(Repo); // { items: Repo[], nextCursor, hasMore }
 * ```
 */
export const Paginated = <A extends Schema.Top>(items: A) =>
  Schema.Struct({
    items: Schema.Array(items),
    nextCursor: Schema.NullOr(Schema.String),
    hasMore: Schema.Boolean,
  });

// ─────────────────────────────────────────────────────────────────────────────
// Groups
// ─────────────────────────────────────────────────────────────────────────────

/** `(owner, repo)` path segments shared by repo-scoped endpoints. */
const RepoPath = Schema.Struct({ owner: OwnerName, repo: RepoName });

/** `(owner, repo, oid)` path segments for object read endpoints. */
const RepoOidPath = Schema.Struct({
  owner: OwnerName,
  repo: RepoName,
  oid: Oid,
});

/**
 * Repo CRUD + fork + import. Create/list-all/fork/import are
 * admin-key-only; get/update/delete accept a suitably scoped repo token
 * (enforced in the Repo DO).
 */
const repos = HttpApiGroup.make("repos")
  .add(
    HttpApiEndpoint.post("create", "/repos", {
      payload: Schema.Struct({
        owner: OwnerName,
        name: RepoName,
        /** Default branch short name. @default "main" */
        defaultBranch: Schema.optional(Schema.String),
        description: Schema.optional(Schema.String),
        /** @default false */
        readOnly: Schema.optional(Schema.Boolean),
      }),
      success: RepoCreated,
      error: [RepoAlreadyExists, ValidationError, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/repos/:owner/:repo", {
      params: RepoPath,
      success: Repo,
      error: RepoNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.patch("update", "/repos/:owner/:repo", {
      params: RepoPath,
      payload: Schema.Struct({
        description: Schema.optional(Schema.NullOr(Schema.String)),
        /** Must resolve to an existing branch. */
        defaultBranch: Schema.optional(Schema.String),
        readOnly: Schema.optional(Schema.Boolean),
      }),
      success: Repo,
      error: [RepoNotFound, RefNotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/repos", {
      query: Schema.Struct({
        owner: Schema.optional(OwnerName),
        cursor: Schema.optional(Schema.String),
        limit: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
        ),
      }),
      success: Paginated(Repo),
    }),
  )
  .add(
    // Async purge: responds 204 immediately, repo `status` flips to
    // 'deleting', name frees after the purge alarm completes (then 404).
    HttpApiEndpoint.delete("delete", "/repos/:owner/:repo", {
      params: RepoPath,
      success: HttpApiSchema.NoContent,
      error: [RepoNotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("fork", "/repos/:owner/:repo/fork", {
      params: RepoPath,
      payload: Schema.Struct({
        targetOwner: OwnerName,
        targetName: RepoName,
      }),
      // status: 'forking'; poll GET /repos/:owner/:repo until 'ready'.
      success: RepoCreated,
      error: [RepoNotFound, RepoAlreadyExists, RepoNotReady, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("import", "/repos/import", {
      payload: Schema.Struct({
        owner: OwnerName,
        name: RepoName,
        source: Schema.Struct({
          /** Smart-HTTP URL of the source repository. */
          url: Schema.String,
          /** Restrict the import to a single ref. */
          ref: Schema.optional(Schema.String),
          /** Depth-limit the imported history. */
          depth: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
        }),
      }),
      // status: 'importing'; poll GET /repos/:owner/:repo until 'ready'.
      success: RepoCreated,
      error: [RepoAlreadyExists, ImportFailed, Forbidden],
    }),
  )
  .middleware(GitAuth);

/**
 * Ref reads and transactional (CAS) writes. Ref names contain `/`, so the
 * single-ref endpoints address the ref via the `name` query parameter,
 * not a path segment.
 */
const refs = HttpApiGroup.make("refs")
  .add(
    HttpApiEndpoint.get("list", "/repos/:owner/:repo/refs", {
      params: RepoPath,
      query: Schema.Struct({
        /** Filter by prefix, e.g. `refs/heads/`. */
        prefix: Schema.optional(Schema.String),
      }),
      success: Schema.Struct({
        /** The default branch's full ref name, `null` on an unborn repo. */
        head: Schema.NullOr(Schema.String),
        refs: Schema.Array(Ref),
      }),
      error: RepoNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("get", "/repos/:owner/:repo/ref", {
      params: RepoPath,
      query: Schema.Struct({ name: RefName }),
      success: Ref,
      error: [RepoNotFound, RefNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.put("update", "/repos/:owner/:repo/ref", {
      params: RepoPath,
      query: Schema.Struct({ name: RefName }),
      payload: Schema.Struct({
        newOid: Oid,
        /**
         * CAS token: current oid the ref must hold. `null` = the ref must
         * not exist (create). Absent = unconditional write.
         */
        expectedOid: Schema.optional(Schema.NullOr(Oid)),
      }),
      success: Ref,
      error: [
        RepoNotFound,
        RefConflict,
        ObjectNotFound,
        ReadOnlyRepo,
        Forbidden,
      ],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", "/repos/:owner/:repo/ref", {
      params: RepoPath,
      query: Schema.Struct({ name: RefName }),
      payload: Schema.Struct({
        /** CAS token: current oid the ref must hold. Absent = unconditional. */
        expectedOid: Schema.optional(Oid),
      }),
      success: HttpApiSchema.NoContent,
      error: [RepoNotFound, RefNotFound, RefConflict, ReadOnlyRepo, Forbidden],
    }),
  )
  .middleware(GitAuth);

/**
 * Object reads: commits, log, trees, small blobs.
 *
 * Raw streaming reads are registered as RAW `HttpRouter` routes
 * (octet-stream), outside HttpApi schema-land by design (same policy as
 * the git wire endpoints):
 *
 * - `GET /api/v1/repos/:owner/:repo/blobs/:oid/raw`
 * - `GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>`
 *   (tree-walk per segment)
 */
const objects = HttpApiGroup.make("objects")
  .add(
    HttpApiEndpoint.get("commit", "/repos/:owner/:repo/commits/:oid", {
      params: RepoOidPath,
      success: CommitInfo,
      error: [RepoNotFound, ObjectNotFound, WrongObjectType],
    }),
  )
  .add(
    HttpApiEndpoint.get("log", "/repos/:owner/:repo/log", {
      params: RepoPath,
      query: Schema.Struct({
        /** Refname or oid to start from. @default HEAD */
        ref: Schema.optional(Schema.String),
        cursor: Schema.optional(Schema.String),
        limit: Schema.optional(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
        ),
      }),
      success: Paginated(CommitInfo),
      error: [RepoNotFound, RefNotFound],
    }),
  )
  .add(
    HttpApiEndpoint.get("tree", "/repos/:owner/:repo/trees/:oid", {
      params: RepoOidPath,
      success: Schema.Struct({
        oid: Oid,
        entries: Schema.Array(TreeEntry),
      }),
      error: [RepoNotFound, ObjectNotFound, WrongObjectType],
    }),
  )
  .add(
    HttpApiEndpoint.get("blob", "/repos/:owner/:repo/blobs/:oid", {
      params: RepoOidPath,
      success: Schema.Struct({
        oid: Oid,
        /** Uncompressed size in bytes. */
        size: Schema.Number,
        encoding: Schema.Literals(["base64"]),
        /** Base64 content — blobs ≤ 1 MiB only (422 otherwise; use /raw). */
        content: Schema.String,
      }),
      error: [RepoNotFound, ObjectNotFound, WrongObjectType, ObjectTooLarge],
    }),
  )
  .middleware(GitAuth);

/**
 * Per-repo token management. Requires the repo `admin` scope (or the
 * admin key); enforced in the Repo DO.
 */
const tokens = HttpApiGroup.make("tokens")
  .add(
    HttpApiEndpoint.post("create", "/repos/:owner/:repo/tokens", {
      params: RepoPath,
      payload: Schema.Struct({
        /** Human-readable label. */
        name: Schema.String,
        scope: TokenScope,
        /** Optional TTL in seconds; absent = no expiry. */
        ttlSeconds: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      }),
      success: CreatedToken,
      error: [RepoNotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.get("list", "/repos/:owner/:repo/tokens", {
      params: RepoPath,
      success: Schema.Array(TokenInfo),
      error: [RepoNotFound, Forbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("revoke", "/repos/:owner/:repo/tokens/:id", {
      params: Schema.Struct({
        owner: OwnerName,
        repo: RepoName,
        id: Schema.String,
      }),
      success: HttpApiSchema.NoContent,
      error: [RepoNotFound, TokenNotFound, Forbidden],
    }),
  )
  .middleware(GitAuth);

/**
 * The complete git-service management-plane API, mounted at `/api/v1`.
 *
 * Authorization matrix (enforced in the Repo DO, DESIGN.md §8):
 * admin key → everything; repo `admin` token → its repo's write + token
 * create/list/revoke + repo update/delete; `write` → its repo's reads +
 * receive-pack + ref writes; `read` → its repo's reads + upload-pack
 * only. Repo create / list-all / fork / import are admin-key-only.
 */
export const GitApi = HttpApi.make("git-service")
  .add(repos)
  .add(refs)
  .add(objects)
  .add(tokens)
  .prefix("/api/v1");
