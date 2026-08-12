/**
 * The stateless git-service Worker (DESIGN.md §2.1, §2.2, §5, §8).
 *
 * The Worker is the front door for both planes:
 *
 * - `/api/v1/**` — the typed REST management plane (`GitApi` from
 *   `Api.ts`), mounted via `HttpApiBuilder.layer` with the `GitAuth`
 *   credential-parsing middleware. Handlers resolve `owner/name → repoId`
 *   through the singleton Registry DO (with a 60 s in-isolate LRU cache)
 *   and call typed Repo-DO RPCs, which are the enforcement point.
 * - `/:owner/:repo[.git]/**` — the git smart-HTTP wire endpoints
 *   (`info/refs`, `git-upload-pack`, `git-receive-pack`), registered as
 *   raw `HttpRouter` routes on the same router and proxied untouched to
 *   the Repo DO's `fetch` (the protocol runs inside the DO, §2.1).
 *
 * The Worker never verifies repo tokens itself — only the deployer admin
 * key (`GIT_SERVICE_ADMIN_TOKEN`, timing-safe compare). Admin-verified
 * requests are forwarded to the DO with the internal {@link ADMIN_HEADER}
 * set (any inbound copy of that header is always stripped first).
 *
 * @section Deploying
 * @example Compose the Worker into a Stack
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import GitWorker from "@alchemy.run/git/GitWorker";
 *
 * export default Alchemy.Stack(
 *   "GitService",
 *   { providers: Cloudflare.providers(), state: Cloudflare.state() },
 *   Effect.gen(function* () {
 *     const worker = yield* GitWorker;
 *     return { url: worker.url.as<string>() };
 *   }),
 * );
 * ```
 *
 * @section Using the deployed service
 * @example Create a repo and push to it
 * ```sh
 * curl -X POST "$URL/api/v1/repos" \
 *   -H "Authorization: Bearer $GIT_SERVICE_ADMIN_TOKEN" \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"acme","name":"web"}'
 * # → { repo, remote, token: { token: "gs_..." } }
 *
 * git remote add origin "https://x:gs_...@<host>/acme/web.git"
 * git push origin main
 * ```
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Etag from "effect/unstable/http/Etag";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import {
  CommitInfo,
  CreatedToken,
  Credentials,
  Forbidden,
  GitApi,
  ImportFailed,
  ObjectStats,
  ObjectTooLarge,
  PushStats,
  Ref,
  Repo,
  RepoAlreadyExists,
  RepoCreated,
  RepoNotFound,
  RepoNotReady,
  TokenInfo,
  TreeEntry,
  Unauthorized,
  type Oid,
} from "./Api.ts";
import { GitAuthLive, parseBasicOrBearer, verifyAdminKey } from "./Auth.ts";
import { parseCommit, parseTree, treeEntryKind } from "./git/ObjectCodec.ts";
import { flushPkt, pktText } from "./git/Pkt.ts";
import { progressMessage, wrapSideband } from "./git/Sideband.ts";
import type { StoreError } from "./git/Store.ts";
import {
  ADMIN_HEADER,
  BUNDLE_COUNT_HEADER,
  BUNDLE_HASH_HEADER,
  BUNDLE_KEY_HEADER,
  BUNDLE_SIDEBAND_HEADER,
  GitObjectsBucket,
  GitRepo,
  GitRepoLive,
  WWW_AUTHENTICATE,
  type CallerAuth,
  type CommitData,
  type CreatedTokenData,
  type RefData,
  type RepoMetaData,
  type TokenData,
} from "./RepoObject.ts";
import {
  Registry,
  RegistryLive,
  REGISTRY_DO_NAME,
  type RegistryEntry,
} from "./RegistryObject.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Config key of the deployer admin secret. Resolved at deploy time from
 * the deployer's environment and bound to the Worker as a secret binding
 * (DESIGN.md §8). Grants: repo create/update/delete/list-all, fork/import,
 * and implicit `admin` scope on every repo.
 */
export const ADMIN_TOKEN_CONFIG_KEY = "GIT_SERVICE_ADMIN_TOKEN" as const;

/** TTL of the in-isolate `owner/name → repoId` cache (DESIGN.md §2.1). */
export const RESOLVE_CACHE_TTL_MS = 60_000;

/** Max entries of the in-isolate resolve cache (insertion-order eviction). */
export const RESOLVE_CACHE_MAX = 1024;

/** Blobs above this size are 422 on the JSON endpoint (use `/raw`). */
export const MAX_JSON_BLOB_BYTES = 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Shared layers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub `HttpPlatform` for Workers (no FileSystem): file responses die,
 * compression is disabled. Copied verbatim from the canonical composition
 * in `packages/alchemy/src/Cloudflare/StateStore/Api.ts`.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
    compressResponse: (response) => Effect.succeed(response),
  },
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

// ─────────────────────────────────────────────────────────────────────────────
// Pure mapping helpers
// ─────────────────────────────────────────────────────────────────────────────

const asOid = (value: string): Oid => value as Oid;

/** Maps the Repo DO's plain metadata onto the REST `Repo` schema class. */
const toRepo = (meta: RepoMetaData): Repo =>
  new Repo({
    owner: meta.owner,
    name: meta.name,
    repoId: meta.repoId,
    defaultBranch: meta.defaultBranch,
    description: meta.description,
    readOnly: meta.readOnly,
    public: meta.public,
    forkOf: meta.forkOf,
    status: meta.status,
    createdAt: meta.createdAt,
    objects: new ObjectStats(meta.objects),
    lastPush: meta.lastPush === null ? null : new PushStats(meta.lastPush),
  });

/** Maps a DO token row onto the REST `TokenInfo` schema class. */
const toTokenInfo = (token: TokenData): TokenInfo =>
  new TokenInfo({
    id: token.id,
    name: token.name,
    scope: token.scope,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
  });

/** Maps a freshly minted DO token onto the REST `CreatedToken` class. */
const toCreatedToken = (token: CreatedTokenData): CreatedToken =>
  new CreatedToken({
    id: token.id,
    name: token.name,
    scope: token.scope,
    createdAt: token.createdAt,
    expiresAt: token.expiresAt,
    lastUsedAt: token.lastUsedAt,
    token: token.token,
  });

/** Maps a DO ref onto the REST `Ref` schema class. */
const toRef = (ref: RefData): Ref =>
  ref.peeled === undefined
    ? new Ref({ name: ref.name, oid: asOid(ref.oid) })
    : new Ref({
        name: ref.name,
        oid: asOid(ref.oid),
        peeled: asOid(ref.peeled),
      });

/** Maps a DO commit onto the REST `CommitInfo` schema class. */
const toCommitInfo = (commit: CommitData): CommitInfo =>
  new CommitInfo({
    oid: asOid(commit.oid),
    tree: asOid(commit.tree),
    parents: commit.parents.map(asOid),
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
  });

/**
 * Registry-derived fallback `Repo` for list pages when a Repo DO cannot be
 * consulted (e.g. its config was never seeded because the create crashed
 * between the Registry insert and `initRepo`).
 */
const registryFallbackRepo = (entry: RegistryEntry): Repo =>
  new Repo({
    owner: entry.owner,
    name: entry.name,
    repoId: entry.repoId,
    defaultBranch: entry.defaultBranch,
    description: entry.description,
    readOnly: entry.readOnly,
    public: entry.public,
    forkOf: entry.forkOf,
    status:
      entry.deletedAt !== null ? "deleting" : (entry.status as Repo["status"]),
    createdAt: entry.createdAt,
    // No DO to ask (unseeded or mid-purge) — report an empty store.
    objects: new ObjectStats({ loose: 0, packed: 0, r2: 0, bytes: 0 }),
    lastPush: null,
  });

// ─────────────────────────────────────────────────────────────────────────────
// The Worker
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The git-service Worker. Hosts the `GitRepo` and `GitRegistry` Durable
 * Objects (their Live layers are provided on this Worker's init effect)
 * plus the shared R2 objects bucket binding, and serves both the REST
 * management plane and the git smart-HTTP wire protocol.
 *
 * Requires `nodejs_compat` (node:zlib / node:crypto in the DO) and a
 * raised CPU limit (`cpu_ms: 300_000`) — pack inflation cannot run under
 * the free plan's 10 ms budget (DESIGN.md §1).
 */
export default class GitWorker extends Cloudflare.Worker<GitWorker>()(
  "GitWorker",
  {
    main: import.meta.url,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
    observability: { enabled: true },
    limits: { cpuMs: 300_000 },
  },
  Effect.gen(function* () {
    // ── init: DO namespaces + admin key ────────────────────────────────────
    // Both namespaces are wrapped so RPC-boundary errors regain their class
    // ── init: DO namespaces + admin key ────────────────────────────────────
    // RPC-boundary tagged errors are reconstructed by the stubs themselves —
    // both DO classes declare `errors: [...]` (see DurableObjectProps.errors).
    const registry = yield* Registry;
    const repos = yield* GitRepo;
    // The Worker streams clone bundles straight out of R2 (DESIGN.md §11):
    // the DO plans the clone, the bytes bypass it entirely.
    const objectsBucket =
      yield* Cloudflare.R2.ReadWriteBucket(GitObjectsBucket);
    const adminKey = yield* Config.redacted(ADMIN_TOKEN_CONFIG_KEY);

    const registryStub = () => registry.getByName(REGISTRY_DO_NAME);

    // ── owner/name → RegistryEntry, 60 s in-isolate LRU (DESIGN.md §2.1) ──
    // A stale hit fails safe: the Repo DO stores its own (owner, name) and
    // 404s mismatched requests, and cache entries are dropped on delete.
    interface CacheSlot {
      readonly entry: RegistryEntry;
      readonly expires: number;
    }
    const resolveCache = new Map<string, CacheSlot>();

    const cacheKey = (owner: string, repo: string) =>
      `${owner.toLowerCase()}/${repo.toLowerCase()}`;

    const dropCached = (owner: string, repo: string) =>
      Effect.sync(() => {
        resolveCache.delete(cacheKey(owner, repo));
      });

    const resolveCached = (owner: string, repo: string) =>
      Effect.gen(function* () {
        const key = cacheKey(owner, repo);
        const now = yield* Effect.sync(() => Date.now());
        const hit = resolveCache.get(key);
        if (hit !== undefined && hit.expires > now) return hit.entry;
        const entry = yield* registryStub().resolve(owner, repo);
        // Rows mid-purge are transient (removed when the purge alarm
        // finishes) — never cache them, or a 60 s stale hit would keep
        // reporting "deleting" after the name has freed.
        if (entry !== undefined && entry.deletedAt === null) {
          yield* Effect.sync(() => {
            if (resolveCache.size >= RESOLVE_CACHE_MAX) {
              const oldest = resolveCache.keys().next().value;
              if (oldest !== undefined) resolveCache.delete(oldest);
            }
            resolveCache.set(key, {
              entry,
              expires: now + RESOLVE_CACHE_TTL_MS,
            });
          });
        }
        return entry;
      });

    /**
     * Resolve including rows whose async purge is still draining
     * (`deletedAt` set) — only `repos.get` (report `status: "deleting"`)
     * and `repos.delete` (idempotent 204) want those.
     */
    const resolveIncludingDeleting = (owner: string, repo: string) =>
      resolveCached(owner, repo).pipe(
        Effect.catchTag("StoreError", (error: StoreError) => Effect.die(error)),
        Effect.flatMap((entry) =>
          entry === undefined
            ? Effect.fail(new RepoNotFound({ owner, repo }))
            : Effect.succeed(entry),
        ),
      );

    /**
     * Resolve or fail with a typed 404. Rows mid-purge count as gone for
     * every data-plane route (the name is reserved but the repo is dead).
     * Storage failures are defects.
     */
    const resolveOrNotFound = (owner: string, repo: string) =>
      resolveIncludingDeleting(owner, repo).pipe(
        Effect.filterOrFail(
          (entry) => entry.deletedAt === null,
          () => new RepoNotFound({ owner, repo }),
        ),
      );

    // ── credentials → CallerAuth ───────────────────────────────────────────
    /**
     * Classifies the parsed credential: the deployer admin key (verified
     * here, timing-safe) or an opaque repo token (verified by the Repo DO).
     */
    const callerAuthFor = (
      token: Redacted.Redacted<string>,
    ): Effect.Effect<CallerAuth> =>
      verifyAdminKey(token, adminKey).pipe(
        Effect.map(
          (isAdmin): CallerAuth =>
            isAdmin
              ? { kind: "admin" }
              : { kind: "token", token: Redacted.value(token) },
        ),
      );

    /**
     * The REST caller's auth, from the `GitAuth`-provided credentials.
     * A missing token is an ANONYMOUS caller — the Repo DO grants it read
     * (and nothing else) on public repos.
     */
    const restAuth: Effect.Effect<CallerAuth, never, Credentials> = Effect.gen(
      function* () {
        const credentials = yield* Credentials;
        if (credentials.token === undefined) {
          return { kind: "anonymous" } as const;
        }
        return yield* callerAuthFor(credentials.token);
      },
    );

    /** Admin-or-403 gate for the admin-key-only endpoints (DESIGN.md §5). */
    const requireAdmin = Effect.gen(function* () {
      const credentials = yield* Credentials;
      const isAdmin =
        credentials.token !== undefined &&
        (yield* verifyAdminKey(credentials.token, adminKey));
      if (!isAdmin) {
        return yield* new Forbidden({ required: "admin" });
      }
    });

    /** HTTPS clone URL for a repo, derived from the incoming Host header. */
    const remoteUrl = (owner: string, name: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const host = request.headers.host;
        const proto = request.headers["x-forwarded-proto"] ?? "https";
        return host === undefined
          ? `/${owner}/${name}.git`
          : `${proto}://${host}/${owner}/${name}.git`;
      });

    // ── REST handler groups ────────────────────────────────────────────────

    /**
     * Inserts the registry row, repairing an ORPHAN first: a row whose Repo
     * DO was never seeded (a create that died between the registry insert
     * and `initRepo`). An orphan poisons the name permanently — `GET` 404s
     * because the DO has no config, while `POST` 409s because the row
     * exists — so detect it (registry row present + DO reports
     * `RepoNotFound`), drop the row, and insert again.
     */
    const insertRepoRow = (input: {
      readonly owner: string;
      readonly name: string;
      readonly description?: string | undefined;
      readonly public?: boolean | undefined;
    }) =>
      registryStub()
        .createRepo(input)
        .pipe(
          Effect.catchTag("StoreError", (error) => Effect.die(error)),
          Effect.catchTag("RepoAlreadyExists", (conflict) =>
            Effect.gen(function* () {
              const existing = yield* resolveCached(
                input.owner,
                input.name,
              ).pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
              if (existing === undefined) {
                return yield* Effect.fail(conflict);
              }
              const orphaned = yield* repos
                .getByName(existing.repoId)
                .getRepoMeta({ kind: "admin" })
                .pipe(
                  Effect.as(false),
                  Effect.catchTag("RepoNotFound", () => Effect.succeed(true)),
                  Effect.catchCause(() => Effect.succeed(false)),
                );
              if (!orphaned) {
                return yield* Effect.fail(conflict);
              }
              yield* registryStub()
                .removeRow(existing.repoId)
                .pipe(
                  Effect.catchTag("StoreError", (error) => Effect.die(error)),
                );
              yield* dropCached(input.owner, input.name);
              return yield* registryStub()
                .createRepo(input)
                .pipe(
                  Effect.catchTag("StoreError", (error) => Effect.die(error)),
                );
            }),
          ),
        );

    const reposGroup = HttpApiBuilder.group(GitApi, "repos", (handlers) =>
      handlers
        .handle("create", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireAdmin;
            const entry = yield* insertRepoRow({
              owner: payload.owner,
              name: payload.name,
              description: payload.description,
              public: payload.public,
            });
            const init = yield* repos
              .getByName(entry.repoId)
              .initRepo({
                repoId: entry.repoId,
                owner: entry.owner,
                name: entry.name,
                defaultBranch: payload.defaultBranch ?? "main",
                description: payload.description ?? null,
                readOnly: payload.readOnly ?? false,
                public: payload.public ?? false,
                forkOf: null,
              })
              .pipe(
                // Seeding the DO failed (or died): drop the row we just
                // inserted rather than leave an orphan behind.
                Effect.onError(() =>
                  registryStub()
                    .removeRow(entry.repoId)
                    .pipe(
                      Effect.ignore,
                      Effect.andThen(dropCached(entry.owner, entry.name)),
                    ),
                ),
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            const remote = yield* remoteUrl(entry.owner, entry.name);
            return new RepoCreated({
              repo: toRepo(init.meta),
              remote,
              token: toCreatedToken(init.token),
            });
          }),
        )
        .handle("get", ({ params }) =>
          Effect.gen(function* () {
            // Includes rows mid-purge: GET keeps reporting
            // status "deleting" until the purge alarm frees the name (only
            // then a 404), so "poll GET until 404 then re-create" never
            // races the purge.
            const entry = yield* resolveIncludingDeleting(
              params.owner,
              params.repo,
            );
            const auth = yield* restAuth;
            if (entry.deletedAt !== null) {
              return registryFallbackRepo(entry);
            }
            const meta = yield* repos
              .getByName(entry.repoId)
              .getRepoMeta(auth)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                // `get` declares only RepoNotFound — an insufficient scope
                // is indistinguishable from a bad token here.
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return toRepo(meta);
          }),
        )
        .handle("update", ({ params, payload }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const meta = yield* repos
              .getByName(entry.repoId)
              .updateRepoMeta(auth, {
                description: payload.description,
                defaultBranch: payload.defaultBranch,
                readOnly: payload.readOnly,
                public: payload.public,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return toRepo(meta);
          }),
        )
        .handle("list", ({ query }) =>
          Effect.gen(function* () {
            // The admin key lists everything; everyone else (tokenless
            // included) sees public repos only — GitHub's model.
            const credentials = yield* Credentials;
            const isAdmin =
              credentials.token !== undefined &&
              (yield* verifyAdminKey(credentials.token, adminKey));
            const page = yield* registryStub()
              .list({
                owner: query.owner,
                cursor: query.cursor,
                limit: query.limit,
                publicOnly: !isAdmin,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            // Rendered straight from the Registry's denormalised columns:
            // listing must NOT wake one Durable Object per row (measured at
            // ~30 ms per row — DESIGN.md §14.1 / §15 bottleneck 7). Live
            // `objects` stats need the DO, so a listing reports zeros and
            // callers who want them read the repo directly.
            const items = page.items.map(registryFallbackRepo);
            return {
              items,
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            };
          }),
        )
        .handle("delete", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveIncludingDeleting(
              params.owner,
              params.repo,
            );
            const auth = yield* restAuth;
            // Always (re-)arm the purge — even when the row is already
            // soft-deleted. A second DELETE mid-drain is an idempotent 204,
            // and re-arming is what recovers a purge whose alarm was lost
            // (crash between markDeleted and the first alarm run).
            yield* repos
              .getByName(entry.repoId)
              .startPurge(auth)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                // The registry row exists but the DO holds no state — an
                // orphan, or a purge that already wiped storage. There is
                // nothing to purge, so free the name directly (never 404:
                // the caller can see this repo, so DELETE must remove it).
                Effect.catchTag("RepoNotFound", () =>
                  registryStub()
                    .removeRow(entry.repoId)
                    .pipe(
                      Effect.catchTag("StoreError", (error) =>
                        Effect.die(error),
                      ),
                    ),
                ),
              );
            yield* registryStub()
              .markDeleted(entry.repoId)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            yield* dropCached(params.owner, params.repo);
          }),
        )
        .handle("fork", ({ params, payload }) =>
          Effect.gen(function* () {
            yield* requireAdmin;
            const source = yield* resolveOrNotFound(params.owner, params.repo);
            const sourceMeta = yield* repos
              .getByName(source.repoId)
              .getRepoMeta({ kind: "admin" })
              .pipe(
                Effect.catchTag(["StoreError", "Unauthorized"], (error) =>
                  Effect.die(error),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            if (sourceMeta.status !== "ready") {
              return yield* new RepoNotReady({ status: sourceMeta.status });
            }
            const entry = yield* registryStub()
              .createRepo({
                owner: payload.targetOwner,
                name: payload.targetName,
                description: sourceMeta.description ?? undefined,
                forkOf: source.repoId,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                // `fork` declares no ValidationError (reserved target
                // owner) — surface it as the closest declared conflict.
                Effect.catchTag("ValidationError", () =>
                  Effect.fail(
                    new RepoAlreadyExists({
                      owner: payload.targetOwner,
                      repo: payload.targetName,
                    }),
                  ),
                ),
              );
            const init = yield* repos
              .getByName(entry.repoId)
              .startFork({
                repoId: entry.repoId,
                owner: entry.owner,
                name: entry.name,
                defaultBranch: sourceMeta.defaultBranch,
                description: sourceMeta.description,
                readOnly: false,
                // Forks inherit the source's visibility.
                public: sourceMeta.public,
                forkOf: source.repoId,
                parentRepoId: source.repoId,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            const remote = yield* remoteUrl(entry.owner, entry.name);
            return new RepoCreated({
              repo: toRepo(init.meta),
              remote,
              token: toCreatedToken(init.token),
            });
          }),
        )
        .handle("compact", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            yield* repos
              .getByName(entry.repoId)
              .startCompact(auth)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Unauthorized", () =>
                  Effect.fail(new Forbidden({ required: "admin" })),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
          }),
        )
        .handle("import", ({ payload }) =>
          Effect.gen(function* () {
            yield* requireAdmin;
            const entry = yield* registryStub()
              .createRepo({
                owner: payload.owner,
                name: payload.name,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                // `import` declares no ValidationError — a reserved owner
                // is an import that can never succeed.
                Effect.catchTag("ValidationError", (error) =>
                  Effect.fail(new ImportFailed({ reason: error.message })),
                ),
              );
            const init = yield* repos
              .getByName(entry.repoId)
              .startImport({
                repoId: entry.repoId,
                owner: entry.owner,
                name: entry.name,
                defaultBranch: "main",
                description: null,
                readOnly: false,
                public: false,
                forkOf: null,
                source: {
                  url: payload.source.url,
                  ref: payload.source.ref,
                  depth: payload.source.depth,
                },
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
              );
            const remote = yield* remoteUrl(entry.owner, entry.name);
            return new RepoCreated({
              repo: toRepo(init.meta),
              remote,
              token: toCreatedToken(init.token),
            });
          }),
        ),
    );

    const refsGroup = HttpApiBuilder.group(GitApi, "refs", (handlers) =>
      handlers
        .handle("list", ({ params, query }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const page = yield* repos
              .getByName(entry.repoId)
              .listRefs(auth, query.prefix)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return { head: page.head, refs: page.refs.map(toRef) };
          }),
        )
        .handle("get", ({ params, query }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const ref = yield* repos
              .getByName(entry.repoId)
              .getRef(auth, query.name)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return toRef(ref);
          }),
        )
        .handle("update", ({ params, query, payload }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const ref = yield* repos
              .getByName(entry.repoId)
              .updateRef(auth, {
                name: query.name,
                newOid: payload.newOid,
                expectedOid: payload.expectedOid,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return toRef(ref);
          }),
        )
        .handle("remove", ({ params, query, payload }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            yield* repos
              .getByName(entry.repoId)
              .removeRef(auth, {
                name: query.name,
                expectedOid: payload.expectedOid,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
          }),
        ),
    );

    const objectsGroup = HttpApiBuilder.group(GitApi, "objects", (handlers) =>
      handlers
        .handle("commit", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const data = yield* repos
              .getByName(entry.repoId)
              .readObject(auth, { oid: params.oid, expect: "commit" })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            // A stored commit that fails to parse is corrupt — a defect.
            const parsed = yield* parseCommit(data.content).pipe(Effect.orDie);
            return new CommitInfo({
              oid: params.oid,
              tree: asOid(parsed.tree),
              parents: parsed.parents.map(asOid),
              author: {
                name: parsed.author.name,
                email: parsed.author.email,
                date: parsed.author.when,
                tz: parsed.author.tz,
              },
              committer: {
                name: parsed.committer.name,
                email: parsed.committer.email,
                date: parsed.committer.when,
                tz: parsed.committer.tz,
              },
              message: parsed.message,
            });
          }),
        )
        .handle("log", ({ params, query }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const page = yield* repos
              .getByName(entry.repoId)
              .readCommitLog(auth, {
                ref: query.ref,
                cursor: query.cursor,
                limit: query.limit,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return {
              items: page.items.map(toCommitInfo),
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            };
          }),
        )
        .handle("tree", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const data = yield* repos
              .getByName(entry.repoId)
              .readObject(auth, { oid: params.oid, expect: "tree" })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            const entries = yield* parseTree(data.content).pipe(Effect.orDie);
            return {
              oid: params.oid,
              entries: entries.map(
                (item) =>
                  new TreeEntry({
                    mode: item.mode,
                    name: item.name,
                    oid: asOid(item.oid),
                    type: treeEntryKind(item.mode),
                  }),
              ),
            };
          }),
        )
        .handle("blob", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const data = yield* repos
              .getByName(entry.repoId)
              .readObject(auth, { oid: params.oid, expect: "blob" })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("Forbidden", () =>
                  Effect.fail(new Unauthorized()),
                ),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            if (data.size > MAX_JSON_BLOB_BYTES) {
              return yield* new ObjectTooLarge({
                oid: params.oid,
                size: data.size,
              });
            }
            return {
              oid: params.oid,
              size: data.size,
              encoding: "base64" as const,
              content: Encoding.encodeBase64(data.content),
            };
          }),
        ),
    );

    const tokensGroup = HttpApiBuilder.group(GitApi, "tokens", (handlers) =>
      handlers
        .handle("create", ({ params, payload }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const created = yield* repos
              .getByName(entry.repoId)
              .createToken(auth, {
                name: payload.name,
                scope: payload.scope,
                ttlSeconds: payload.ttlSeconds,
              })
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return toCreatedToken(created);
          }),
        )
        .handle("list", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            const tokens = yield* repos
              .getByName(entry.repoId)
              .listTokens(auth)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
            return tokens.map(toTokenInfo);
          }),
        )
        .handle("revoke", ({ params }) =>
          Effect.gen(function* () {
            const entry = yield* resolveOrNotFound(params.owner, params.repo);
            const auth = yield* restAuth;
            yield* repos
              .getByName(entry.repoId)
              .revokeToken(auth, params.id)
              .pipe(
                Effect.catchTag("StoreError", (error) => Effect.die(error)),
                Effect.catchTag("RepoNotFound", () =>
                  Effect.fail(
                    new RepoNotFound({
                      owner: params.owner,
                      repo: params.repo,
                    }),
                  ),
                ),
              );
          }),
        ),
    );

    // ── raw routes ─────────────────────────────────────────────────────────

    const wire401 = HttpServerResponse.empty({
      status: 401,
      headers: { "www-authenticate": WWW_AUTHENTICATE },
    });
    const notFound = HttpServerResponse.text("repository not found", {
      status: 404,
    });
    const internalError = HttpServerResponse.text("internal error", {
      status: 500,
    });

    /**
     * Shared git wire proxy (`info/refs`, `git-upload-pack`,
     * `git-receive-pack`): parse Basic/Bearer, resolve through the cache,
     * verify the admin key (setting {@link ADMIN_HEADER} when it matches,
     * always stripping any inbound copy), then forward the request
     * untouched to the Repo DO — which re-verifies owner/name, enforces
     * the token, and runs the protocol (DESIGN.md §2.3).
     */
    const wireProxy = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const owner = (params.owner ?? "").toLowerCase();
      let repo = (params.repo ?? "").toLowerCase();
      if (repo.endsWith(".git")) repo = repo.slice(0, -4);

      // Anonymous wire requests are forwarded to the DO, which allows
      // read-only access (advertisement + upload-pack) on public repos and
      // answers 401 + WWW-Authenticate otherwise so git prompts for creds.
      const credentials = parseBasicOrBearer(request.headers);

      const resolved = yield* Effect.result(resolveCached(owner, repo));
      if (Result.isFailure(resolved)) {
        return internalError;
      }
      const entry = resolved.success;
      if (entry === undefined) {
        return notFound;
      }

      const isAdmin =
        credentials !== undefined &&
        (yield* verifyAdminKey(credentials.token, adminKey));
      // Never trust an inbound admin header — only the Worker mints it.
      let headers = Headers.remove(request.headers, ADMIN_HEADER);
      if (isAdmin) {
        headers = Headers.set(headers, ADMIN_HEADER, "1");
      }
      const response = yield* repos
        .getByName(entry.repoId)
        .fetch(request.modify({ headers }));

      // Clone-bundle splice (DESIGN.md §11): the DO answered with a marker
      // naming an immutable R2 object rather than the pack itself. Stream
      // those bytes to the client from here, so the pack never transits
      // the Durable Object — this is what makes clone bandwidth scale with
      // Workers/R2 instead of with one single-threaded object.
      const bundleKeyHeader = response.headers[BUNDLE_KEY_HEADER];
      if (bundleKeyHeader === undefined) {
        return response;
      }
      const object = yield* Effect.result(objectsBucket.get(bundleKeyHeader));
      if (Result.isFailure(object) || object.success === null) {
        // The bundle vanished (GC raced us): fall back to a plain 500 —
        // git retries, and the next attempt re-plans against a fresh
        // bundle or the dynamic path.
        return internalError;
      }
      const packBytes = object.success.body;
      const nak = pktText("NAK");
      const count = response.headers[BUNDLE_COUNT_HEADER] ?? "0";
      const body =
        response.headers[BUNDLE_SIDEBAND_HEADER] === "1"
          ? Stream.fromArray([
              nak,
              progressMessage(`Enumerating objects: ${count}, done.`),
            ]).pipe(
              Stream.concat(packBytes.pipe(wrapSideband(1))),
              Stream.concat(Stream.succeed(flushPkt)),
            )
          : Stream.fromArray([nak]).pipe(Stream.concat(packBytes));
      return HttpServerResponse.stream(body, {
        contentType: "application/x-git-upload-pack-result",
        headers: {
          "cache-control": "no-cache",
          // Kept for observability; the internal marker headers are not.
          [BUNDLE_HASH_HEADER]: response.headers[BUNDLE_HASH_HEADER] ?? "",
        },
      });
    });

    /** Auth + resolve for the raw REST reads; `undefined` = already replied. */
    const rawRestPrelude = (ownerRaw: string, repoRaw: string) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const credentials = parseBasicOrBearer(request.headers);
        const resolved = yield* Effect.result(resolveCached(ownerRaw, repoRaw));
        if (Result.isFailure(resolved)) {
          return { kind: "halt", response: internalError } as const;
        }
        if (resolved.success === undefined) {
          return { kind: "halt", response: notFound } as const;
        }
        // Tokenless raw reads reach the DO as anonymous; it grants read on
        // public repos and 401s the rest.
        const auth: CallerAuth =
          credentials === undefined
            ? { kind: "anonymous" }
            : yield* callerAuthFor(credentials.token);
        return { kind: "ok", entry: resolved.success, auth } as const;
      });

    /**
     * `GET /api/v1/repos/:owner/:repo/blobs/:oid/raw` — raw blob bytes,
     * octet-stream, no size cap (the per-object 64 MiB ingest cap is the
     * outer bound). Outside HttpApi schema-land by design (DESIGN.md §5).
     */
    const blobRawRoute = Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const prelude = yield* rawRestPrelude(
        params.owner ?? "",
        params.repo ?? "",
      );
      if (prelude.kind === "halt") return prelude.response;
      return yield* repos
        .getByName(prelude.entry.repoId)
        .readObject(prelude.auth, { oid: params.oid ?? "", expect: "blob" })
        .pipe(
          Effect.map((data) =>
            HttpServerResponse.uint8Array(data.content, {
              contentType: "application/octet-stream",
            }),
          ),
          Effect.catchTag("Unauthorized", () => Effect.succeed(wire401)),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(
              HttpServerResponse.text("forbidden", { status: 403 }),
            ),
          ),
          Effect.catchTag(["RepoNotFound", "ObjectNotFound"], () =>
            Effect.succeed(
              HttpServerResponse.text("not found", { status: 404 }),
            ),
          ),
          Effect.catchTag("WrongObjectType", (error) =>
            Effect.succeed(
              HttpServerResponse.text(
                `object ${error.oid} is a ${error.actual}, not a ${error.expected}`,
                { status: 422 },
              ),
            ),
          ),
          Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
        );
    });

    /**
     * `GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>` —
     * file-at-path bytes via tree walk, octet-stream (DESIGN.md §2.2).
     */
    const fileRoute = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const url = new URL(request.url, "http://worker");
      const path = url.searchParams.get("path");
      const ref = url.searchParams.get("ref") ?? undefined;
      if (path === null || path.length === 0) {
        return HttpServerResponse.text("missing ?path", { status: 400 });
      }
      const prelude = yield* rawRestPrelude(
        params.owner ?? "",
        params.repo ?? "",
      );
      if (prelude.kind === "halt") return prelude.response;
      return yield* repos
        .getByName(prelude.entry.repoId)
        .readFileAtPath(prelude.auth, { ref, path })
        .pipe(
          Effect.map((file) =>
            HttpServerResponse.uint8Array(file.content, {
              contentType: "application/octet-stream",
            }),
          ),
          Effect.catchTag("Unauthorized", () => Effect.succeed(wire401)),
          Effect.catchTag("Forbidden", () =>
            Effect.succeed(
              HttpServerResponse.text("forbidden", { status: 403 }),
            ),
          ),
          Effect.catchTag(
            ["RepoNotFound", "RefNotFound", "ObjectNotFound"],
            () =>
              Effect.succeed(
                HttpServerResponse.text("not found", { status: 404 }),
              ),
          ),
          Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
        );
    });

    const rawRoutes = Layer.mergeAll(
      HttpRouter.add("GET", "/:owner/:repo/info/refs", wireProxy),
      HttpRouter.add("POST", "/:owner/:repo/git-upload-pack", wireProxy),
      HttpRouter.add("POST", "/:owner/:repo/git-receive-pack", wireProxy),
      HttpRouter.add(
        "GET",
        "/api/v1/repos/:owner/:repo/blobs/:oid/raw",
        blobRawRoute,
      ),
      HttpRouter.add("GET", "/api/v1/repos/:owner/:repo/file", fileRoute),
    );

    // ── mount (canonical StateStore/Api.ts composition) ────────────────────
    return {
      fetch: HttpApiBuilder.layer(GitApi).pipe(
        Layer.provide([reposGroup, refsGroup, objectsGroup, tokensGroup]),
        Layer.provide(GitAuthLive),
        Layer.merge(rawRoutes),
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
        // Browser clients (e.g. the example SPA) call the REST plane
        // cross-origin with a bearer token. Tokens are sent explicitly via
        // `Authorization` (never cookies), so echoing any origin without
        // credentials is safe. `toHttpEffect` yields the handler effect, so
        // the middleware wraps via `Effect.map`.
        Effect.map(
          HttpMiddleware.cors({
            allowedMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
            allowedHeaders: ["Authorization", "Content-Type"],
            maxAge: 86_400,
          }),
        ),
      ),
    };
  }).pipe(
    // The Worker hosts both DOs; their Live layers (and the R2 binding the
    // Repo DO's init resolves) are provided here so they bundle into this
    // script and register their bindings at plan time. One Effect.provide
    // call with a merged layer so the shared RegistryLive builds once
    // (MemoMap dedupe on the module-level layer reference).
    Effect.provide(
      Layer.mergeAll(
        RegistryLive,
        GitRepoLive.pipe(
          Layer.provide(RegistryLive),
          Layer.provide(Cloudflare.R2.ReadWriteBucketBinding),
        ),
        // The Worker itself reads R2 too (the clone-bundle splice).
        Cloudflare.R2.ReadWriteBucketBinding,
      ),
    ),
  ),
) {}
