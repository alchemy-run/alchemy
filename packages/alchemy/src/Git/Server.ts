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
 * ### Deploying
 * **Example:** Compose the Worker into a Stack
 * ```typescript
 * import * as Alchemy from "../index.ts";
 * import * as Cloudflare from "../Cloudflare/index.ts";
 * import * as Effect from "effect/Effect";
 * import GitWorker from "alchemy/Git/GitWorker";
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
 * ### Using the deployed service
 * **Example:** Create a repo and push to it
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
import * as Cloudflare from "../Cloudflare/index.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
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
  CommitDiff,
  CommitInfo,
  Comparison,
  CreatedToken,
  Credentials,
  DiffEntry,
  Forbidden,
  GitApi,
  ImportFailed,
  MergeResult,
  ObjectStats,
  ObjectTooLarge,
  Pull,
  PullDetail,
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
import {
  Auth,
  GitAuthLive,
  parseBasicOrBearer,
  type GitAction,
} from "./Auth.ts";
import { githubCompatRoutes } from "./GithubCompat.ts";
import { BlobStore, type BlobStoreError } from "./BlobStore.ts";
import { bundleCovers, type BundleInfo } from "./jobs/Bundle.ts";
import { headKey } from "./store/Keys.ts";
import { decodeHeadSnapshot } from "./store/HeadSnapshot.ts";
import {
  concatBytes,
  parseCommit,
  parseTree,
  treeEntryKind,
  utf8Decode,
} from "./git/ObjectCodec.ts";
import { decodePktLines, flushPkt, pktText } from "./git/Pkt.ts";
import { progressMessage, pumpPackBody, wrapSideband } from "./git/Sideband.ts";
import type { StoreError } from "./git/Store.ts";
import {
  ADMIN_HEADER,
  buildAdvertisement,
  parseUploadPackRequest,
  BUNDLE_COUNT_HEADER,
  BUNDLE_HASH_HEADER,
  BUNDLE_KEY_HEADER,
  BUNDLE_SIDEBAND_HEADER,
  GitRepo,
  GitRepoLive,
  WWW_AUTHENTICATE,
  type CallerAuth,
  type CommitData,
  type CreatedTokenData,
  type DiffEntryData,
  type PullData,
  type PullDetailData,
  type RefData,
  type RepoMetaData,
  type TokenData,
} from "./RepoObject.ts";
import { RegistryStore, type RegistryEntry } from "./RegistryObject.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// ADMIN_TOKEN_CONFIG_KEY moved to Auth.ts with the Auth contract; the
// re-export below keeps the import path stable.
export { ADMIN_TOKEN_CONFIG_KEY } from "./Auth.ts";

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

/** Maps a DO diff entry onto the REST `DiffEntry` schema class. */
const toDiffEntry = (entry: DiffEntryData): DiffEntry =>
  new DiffEntry({
    path: entry.path,
    status: entry.status,
    oldOid: entry.oldOid === undefined ? undefined : asOid(entry.oldOid),
    newOid: entry.newOid === undefined ? undefined : asOid(entry.newOid),
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    oldSize: entry.oldSize,
    newSize: entry.newSize,
  });

/** Maps a DO pull row onto the REST `Pull` schema class. */
const toPull = (pull: PullData): Pull =>
  new Pull({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    state: pull.state,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommit === null ? null : asOid(pull.mergeCommit),
  });

/** Maps a DO pull detail onto the REST `PullDetail` schema class. */
const toPullDetail = (pull: PullDetailData): PullDetail =>
  new PullDetail({
    number: pull.number,
    title: pull.title,
    body: pull.body,
    baseRef: pull.baseRef,
    headRef: pull.headRef,
    state: pull.state,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    mergedAt: pull.mergedAt,
    mergeCommit: pull.mergeCommit === null ? null : asOid(pull.mergeCommit),
    baseOid: pull.baseOid === null ? null : asOid(pull.baseOid),
    headOid: pull.headOid === null ? null : asOid(pull.headOid),
    mergeBase: pull.mergeBase === null ? null : asOid(pull.mergeBase),
    aheadBy: pull.aheadBy,
    behindBy: pull.behindBy,
    mergeable: pull.mergeable,
    mergeableReason: pull.mergeableReason,
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
    objects: new ObjectStats({
      loose: 0,
      resident: 0,
      packed: 0,
      r2: 0,
      bytes: 0,
    }),
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
/**
 * Worker options every `Git.Server` host needs: `nodejs_compat` (zlib +
 * crypto in the codec layer) and a generous CPU ceiling for pack ingest.
 * Spread into your `Cloudflare.Worker` definition.
 */
export const GIT_WORKER_OPTIONS = {
  compatibility: {
    flags: ["nodejs_compat"] as Array<"nodejs_compat">,
    date: "2026-03-17",
  },
  limits: { cpuMs: 300_000 },
};

const make = Effect.gen(function* () {
  // ── init: DO namespaces + admin key ────────────────────────────────────
  // Both namespaces are wrapped so RPC-boundary errors regain their class
  // ── init: DO namespaces + admin key ────────────────────────────────────
  // RPC-boundary tagged errors are reconstructed by the stubs themselves —
  // both DO classes declare `errors: [...]` (see DurableObjectProps.errors).
  const registry = yield* RegistryStore;
  const repos = yield* GitRepo;
  // The Worker streams clone bundles straight out of R2 (DESIGN.md §11):
  // the DO plans the clone, the bytes bypass it entirely.
  // The Worker-side view of the blob store (clone-bundle splice reads)
  // — the same BlobStore layer the Repo DO consumes.
  const workerBlobs = yield* BlobStore;
  // The swappable auth block (§3.2): authentication runs here at the
  // Worker, once per request; registry-level authorization too. Per-repo
  // authorization runs in the Repo DO, which owns the actions' facts.
  const authService = yield* Auth;

  // The registry block, whichever backend the assembly provided.
  const registryStub = () => registry;

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

  // ── request → Actor (the Auth block's authenticate) ────────────────────
  /**
   * The REST caller's identity, resolved by the Auth block from the raw
   * request headers. An absent/unparseable credential is the ANONYMOUS
   * actor — endpoints that need auth deny it at authorize time.
   */
  const restAuth = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* authService.authenticate(request.headers);
  });

  /**
   * Authorize-or-403 gate for the registry-level endpoints (create,
   * fork, import, list-all) — `repo` is `null`: there is no repo
   * context yet, only the action.
   */
  const requireRegistryAction = (action: GitAction) =>
    Effect.gen(function* () {
      const actor = yield* restAuth;
      const allowed = yield* authService.authorize({
        actor,
        repo: null,
        action,
      });
      if (!allowed) {
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
            const existing = yield* resolveCached(input.owner, input.name).pipe(
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
          yield* requireRegistryAction({
            _tag: "CreateRepo",
            owner: payload.owner,
          });
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
          // Whoever the Auth block lets list everything (the admin key,
          // under AuthTokens) sees all repos; everyone else (tokenless
          // included) sees public repos only — GitHub's model.
          const actor = yield* restAuth;
          const isAdmin = yield* authService.authorize({
            actor,
            repo: null,
            action: { _tag: "ListRepos" },
          });
          const page = yield* registryStub()
            .list({
              owner: query.owner,
              cursor: query.cursor,
              limit: query.limit,
              publicOnly: !isAdmin,
            })
            .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
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
                    Effect.catchTag("StoreError", (error) => Effect.die(error)),
                  ),
              ),
            );
          yield* registryStub()
            .markDeleted(entry.repoId)
            .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
          yield* dropCached(params.owner, params.repo);
        }),
      )
      .handle("fork", ({ params, payload }) =>
        Effect.gen(function* () {
          yield* requireRegistryAction({
            _tag: "CreateRepo",
            owner: payload.targetOwner,
          });
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
            .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
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
          yield* requireRegistryAction({
            _tag: "CreateRepo",
            owner: payload.owner,
          });
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
            .pipe(Effect.catchTag("StoreError", (error) => Effect.die(error)));
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
      )
      .handle("diff", ({ params }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const data = yield* repos
            .getByName(entry.repoId)
            .readCommitDiff(auth, { oid: params.oid })
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
          return new CommitDiff({
            oid: params.oid,
            parent: data.parent === null ? null : asOid(data.parent),
            files: data.files.map(toDiffEntry),
            truncated: data.truncated,
          });
        }),
      )
      .handle("compare", ({ params, query }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const data = yield* repos
            .getByName(entry.repoId)
            .compareCommits(auth, { base: query.base, head: query.head })
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
          return new Comparison({
            base: asOid(data.base),
            head: asOid(data.head),
            mergeBase: asOid(data.mergeBase),
            aheadBy: data.aheadBy,
            behindBy: data.behindBy,
            commits: data.commits.map(toCommitInfo),
            commitsTruncated: data.commitsTruncated,
            files: data.files.map(toDiffEntry),
            filesTruncated: data.filesTruncated,
          });
        }),
      ),
  );

  const pullsGroup = HttpApiBuilder.group(GitApi, "pulls", (handlers) =>
    handlers
      .handle("create", ({ params, payload }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const pull = yield* repos
            .getByName(entry.repoId)
            .createPull(auth, {
              title: payload.title,
              body: payload.body,
              base: payload.base,
              head: payload.head,
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
          return toPull(pull);
        }),
      )
      .handle("list", ({ params, query }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const page = yield* repos
            .getByName(entry.repoId)
            .listPulls(auth, {
              state: query.state,
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
            items: page.items.map(toPull),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          };
        }),
      )
      .handle("get", ({ params }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const detail = yield* repos
            .getByName(entry.repoId)
            .getPull(auth, params.number)
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
          return toPullDetail(detail);
        }),
      )
      .handle("update", ({ params, payload }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const pull = yield* repos
            .getByName(entry.repoId)
            .updatePull(auth, {
              number: params.number,
              title: payload.title,
              body: payload.body,
              state: payload.state,
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
          return toPull(pull);
        }),
      )
      .handle("merge", ({ params, payload }) =>
        Effect.gen(function* () {
          const entry = yield* resolveOrNotFound(params.owner, params.repo);
          const auth = yield* restAuth;
          const result = yield* repos
            .getByName(entry.repoId)
            .mergePull(auth, {
              number: params.number,
              message: payload.message,
              expectedHeadOid: payload.expectedHeadOid,
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
          return new MergeResult({
            method: result.method,
            oid: asOid(result.oid),
            pull: toPull(result.pull),
          });
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
  /**
   * Streams a clone bundle out of the BlobStore as a complete
   * upload-pack result (NAK + optionally sideband-framed pack).
   * `undefined` when the bundle bytes are gone (GC raced us).
   */
  /**
   * Wraps pack bytes as a complete upload-pack result (NAK, optional
   * sideband framing, flush). `shape` distinguishes a bundle streamed
   * verbatim from one spliced with a delta — surfaced on
   * `x-git-served-by` so which plane answered is observable, and
   * assertable in the benchmarks.
   */
  const respondWithPack = (
    packBytes: Stream.Stream<Uint8Array, BlobStoreError>,
    options: {
      readonly refsHash: string;
      readonly objectCount: number;
      readonly sideband: boolean;
      readonly via: "do-bundle" | "head-snapshot";
      /** The store's native stream, when it has one (R2 does). */
      readonly readable?: ReadableStream<Uint8Array> | undefined;
      /** `readable` is the pre-framed twin (sideband only). */
      readonly framed?: boolean | undefined;
    },
    shape: "bundle",
  ) => {
    const nak = pktText("NAK");
    const headers = {
      "cache-control": "no-cache",
      "x-git-served-by": `${options.via}:${shape}${options.framed === true ? "+framed" : ""}`,
      [BUNDLE_HASH_HEADER]: options.refsHash,
    };
    // Native path (DESIGN §22): R2's own stream pipes into the Response
    // through web streams only. The bundle bytes never enter an Effect
    // stream, so there is no fiber hand-off per chunk — that hand-off
    // was measured as the ceiling on clone throughput. Sideband framing
    // is a TransformStream emitting 5-byte headers + subarrays (no copy);
    // the raw case is an IdentityTransformStream, which workerd pipes
    // without JS touching the bytes at all.
    if (options.readable !== undefined) {
      const source = options.readable;
      const prefix = options.sideband
        ? concatBytes([
            nak,
            progressMessage(
              `Enumerating objects: ${options.objectCount}, done.`,
            ),
          ])
        : nak;
      const out = pumpPackBody({
        prefix,
        source,
        sideband: options.sideband,
        framed: options.framed,
      });
      return HttpServerResponse.raw(out, {
        contentType: "application/x-git-upload-pack-result",
        headers,
      });
    }
    const body = options.sideband
      ? Stream.fromArray([
          nak,
          progressMessage(`Enumerating objects: ${options.objectCount}, done.`),
        ]).pipe(
          Stream.concat(packBytes.pipe(wrapSideband(1))),
          Stream.concat(Stream.succeed(flushPkt)),
        )
      : Stream.fromArray([nak]).pipe(Stream.concat(packBytes));
    return HttpServerResponse.stream(body, {
      contentType: "application/x-git-upload-pack-result",
      headers,
    });
  };

  const serveBundle = Effect.fn(function* (options: {
    readonly key: string;
    readonly refsHash: string;
    readonly objectCount: number;
    readonly sideband: boolean;
    /** Which plane produced the plan — observability + bench assertions. */
    readonly via: "do-bundle" | "head-snapshot";
  }) {
    if (options.sideband) {
      // Prefer the pre-framed twin: a pure platform pipe (Keys.ts).
      const framed = yield* Effect.result(
        workerBlobs.get(options.key.replace(/\.pack$/, ".sideband")),
      );
      if (
        Result.isSuccess(framed) &&
        framed.success !== null &&
        framed.success.readable !== undefined
      ) {
        return respondWithPack(
          framed.success.stream,
          { ...options, readable: framed.success.readable, framed: true },
          "bundle",
        );
      }
    }
    const object = yield* Effect.result(workerBlobs.get(options.key));
    if (Result.isFailure(object) || object.success === null) {
      return undefined;
    }
    return respondWithPack(
      object.success.stream,
      { ...options, readable: object.success.readable },
      "bundle",
    );
  });

  /**
   * The DO-less anonymous read path (DESIGN.md §21): the upload-pack
   * advertisement and bundle-covered full clones served straight from
   * the repo's head snapshot in the BlobStore — the Repo DO never
   * wakes, so anonymous public read throughput scales with Workers +
   * blob storage instead of one single-threaded object.
   *
   * `undefined` = not eligible; the caller forwards to the DO. Only
   * ever entered for requests with NO credential: a presented token
   * must be verified (and possibly rejected) by the DO, and the Auth
   * block still gets the decision on anonymous access — this changes
   * WHERE the answer is computed, never what it is.
   */
  const anonymousFastPath = Effect.fn(function* (
    request: HttpServerRequest.HttpServerRequest,
    repoId: string,
  ) {
    const target = new URL(request.url, "http://wire");
    const isAdvertisement =
      request.method === "GET" &&
      target.pathname.endsWith("/info/refs") &&
      target.searchParams.get("service") === "git-upload-pack";
    const isUploadPack =
      request.method === "POST" && target.pathname.endsWith("/git-upload-pack");
    if (!isAdvertisement && !isUploadPack) return undefined;
    // Compressed bodies carry big negotiation rounds — the DO owns
    // those (and the gunzip) anyway.
    if (isUploadPack && request.headers["content-encoding"] !== undefined) {
      return undefined;
    }

    const object = yield* Effect.result(workerBlobs.get(headKey(repoId)));
    if (Result.isFailure(object) || object.success === null) {
      return undefined;
    }
    const raw = yield* Effect.result(object.success.bytes);
    if (Result.isFailure(raw)) return undefined;
    const snapshot = decodeHeadSnapshot(utf8Decode(raw.success));
    if (snapshot === undefined) return undefined;

    // The Auth block decides anonymous access — the same question the
    // DO would ask, answered here from the snapshot's repo context.
    const allowed = yield* authService.authorize({
      actor: { kind: "anonymous" },
      repo: {
        repoId: snapshot.repoId,
        owner: snapshot.owner,
        name: snapshot.name,
        public: snapshot.public,
        defaultBranch: snapshot.defaultBranch,
        readOnly: snapshot.readOnly,
      },
      action: { _tag: "Fetch" },
    });
    if (!allowed) return undefined;

    if (isAdvertisement) {
      return HttpServerResponse.uint8Array(
        buildAdvertisement({
          service: "git-upload-pack",
          defaultBranch: snapshot.defaultBranch,
          refs: snapshot.refs,
        }),
        {
          contentType: "application/x-git-upload-pack-advertisement",
          headers: {
            "cache-control": "no-cache",
            "x-git-served-by": "head-snapshot",
          },
        },
      );
    }

    const bundle: BundleInfo | undefined = snapshot.bundle;
    if (bundle === undefined) return undefined;
    // Read the request body from a CLONE of the platform request so a
    // fall-through still forwards the original, unconsumed body.
    const source = request.source;
    if (!(source instanceof Request)) return undefined;
    const bodyResult = yield* Effect.result(
      Effect.tryPromise(() => source.clone().arrayBuffer()),
    );
    if (Result.isFailure(bodyResult)) return undefined;
    const req = yield* decodePktLines(new Uint8Array(bodyResult.success)).pipe(
      Effect.flatMap(parseUploadPackRequest),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (req === undefined) return undefined;
    if (
      !req.done ||
      !bundleCovers(bundle, {
        wants: req.wants,
        haves: req.haves,
        depth: req.depth,
        clientShallow: req.clientShallow,
      })
    ) {
      return undefined;
    }
    return yield* serveBundle({
      key: bundle.key,
      refsHash: bundle.refsHash,
      objectCount: bundle.objectCount,
      sideband: req.capabilities.has("side-band-64k"),
      via: "head-snapshot",
    });
  });

  const wireProxy = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const owner = (params.owner ?? "").toLowerCase();
    let repo = (params.repo ?? "").toLowerCase();
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);

    // Anonymous wire requests are forwarded to the DO, which asks the
    // Auth block (read-only access on public repos) and answers 401 +
    // WWW-Authenticate otherwise so git prompts for creds.
    const resolved = yield* Effect.result(resolveCached(owner, repo));
    if (Result.isFailure(resolved)) {
      return internalError;
    }
    const entry = resolved.success;
    if (entry === undefined) {
      return notFound;
    }

    if (parseBasicOrBearer(request.headers) === undefined) {
      const fast = yield* anonymousFastPath(request, entry.repoId);
      if (fast !== undefined) return fast;
    }

    const actor = yield* authService.authenticate(request.headers);
    const isAdmin = actor.kind === "admin";
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
    const served = yield* serveBundle({
      key: bundleKeyHeader,
      refsHash: response.headers[BUNDLE_HASH_HEADER] ?? "",
      objectCount: Number(response.headers[BUNDLE_COUNT_HEADER] ?? "0"),
      sideband: response.headers[BUNDLE_SIDEBAND_HEADER] === "1",
      via: "do-bundle",
    });
    // The bundle vanished (GC raced us): fall back to a plain 500 — git
    // retries, and the next attempt re-plans against a fresh bundle or
    // the dynamic path.
    return served ?? internalError;
  });

  /** Auth + resolve for the raw REST reads; `undefined` = already replied. */
  const rawRestPrelude = (ownerRaw: string, repoRaw: string) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const resolved = yield* Effect.result(resolveCached(ownerRaw, repoRaw));
      if (Result.isFailure(resolved)) {
        return { kind: "halt", response: internalError } as const;
      }
      if (resolved.success === undefined) {
        return { kind: "halt", response: notFound } as const;
      }
      // Tokenless raw reads reach the DO as anonymous; the Auth block
      // grants read on public repos and 401s the rest.
      const auth = yield* authService.authenticate(request.headers);
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
          Effect.succeed(HttpServerResponse.text("forbidden", { status: 403 })),
        ),
        Effect.catchTag(["RepoNotFound", "ObjectNotFound"], () =>
          Effect.succeed(HttpServerResponse.text("not found", { status: 404 })),
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
          Effect.succeed(HttpServerResponse.text("forbidden", { status: 403 })),
        ),
        Effect.catchTag(["RepoNotFound", "RefNotFound", "ObjectNotFound"], () =>
          Effect.succeed(HttpServerResponse.text("not found", { status: 404 })),
        ),
        Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
      );
  });

  // GitHub REST v3 compatibility facade (`gh api`, Octokit): reuses the
  // same prelude + DO stubs; auth enforcement stays in the DO.
  const githubRoutes = githubCompatRoutes({
    prelude: rawRestPrelude,
    isAdmin: (headers) =>
      Effect.gen(function* () {
        const actor = yield* authService.authenticate(headers);
        return actor.kind === "admin";
      }),
    stub: (repoId) => repos.getByName(repoId),
  });

  const rawRoutes = Layer.mergeAll(
    githubRoutes,
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
      Layer.provide([
        reposGroup,
        refsGroup,
        objectsGroup,
        pullsGroup,
        tokensGroup,
      ]),
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
});

/**
 * `Git.Server` — the top-level building block (RFC "Git Building
 * Blocks" §4): a `Context.Service` exposing the composed HTTP handler
 * for all three planes (git smart-HTTP wire, `/api/v1` REST, `/api/v3`
 * GitHub compat). The package ships no Worker — construct your own and
 * wire `fetch` in:
 *
 * ```ts
 * const GitLive = Git.ServerLive.pipe(
 *   Layer.provide(Git.ReposDurableObject),
 *   Layer.provide(Git.RegistryDurableObject),
 * );
 *
 * export default class GitHost extends Cloudflare.Worker<GitHost>()(
 *   "git",
 *   { main: import.meta.url, ...Git.GIT_WORKER_OPTIONS },
 *   Effect.gen(function* () {
 *     const git = yield* Git.Server;
 *     return { fetch: git.fetch };
 *   }).pipe(Effect.provide(GitLive)),
 * ) {}
 * ```
 */
export class Server extends Context.Service<
  Server,
  Effect.Success<typeof make>
>()("alchemy/Git/Server") {}

/**
 * The default `Git.Server` assembly: all three planes over the Repo and
 * Registry Durable Objects. Provide {@link ReposDurableObject} and
 * {@link RegistryDurableObject} (or your own implementations of the
 * underlying namespaces) in the same layer graph.
 *
 * @layer
 * @provides Git.Server
 */
export const ServerLive = Layer.effect(Server, make);

/**
 * Hosts the `GitRegistry` Durable Object (owner/name → repoId) and
 * provides its namespace service.
 *
 * @layer
 */

/**
 * Hosts the `GitRepo` Durable Object (refs, objects, tokens, pulls, the
 * wire protocol) and provides its namespace service. Requires a
 * {@link BlobStore} — provide `Git.BlobStoreR2(yourBucket)` in the same
 * layer graph; one provision serves this DO and the Worker-side reads.
 *
 * @layer
 */
export const ReposDurableObject = GitRepoLive;
