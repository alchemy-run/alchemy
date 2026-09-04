/**
 * The stateless git-service Worker (DESIGN.md §2.1, §2.2, §5, §8).
 *
 * The Worker is the front door for both planes:
 *
 * - `/api/v1/**` — the typed REST management plane (`GitApi` from
 *   `Api.ts`). Handlers resolve `owner/name → repoId` through the
 *   singleton Registry DO (with a 60 s in-isolate LRU cache) and call
 *   typed Repo-DO RPCs.
 * - `/:owner/:repo[.git]/**` — the git smart-HTTP wire endpoints
 *   (`info/refs`, `git-upload-pack`, `git-receive-pack`), routes on the
 *   same API, proxied untouched to the Repo DO's `fetch` (the protocol
 *   runs inside the DO, §2.1) or served from the head snapshot.
 *
 * The Worker holds no credentials and asks no auth questions: the
 * middleware of the API that mounts the routes decided who may call them
 * before the engine saw the request (DESIGN.md §8). `Git.Hooks`, when
 * provided, runs before refs move.
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
 *   -H "Authorization: Bearer $GIT_SERVICE_SECRET" \
 *   -H "Content-Type: application/json" \
 *   -d '{"owner":"acme","name":"web"}'
 * # → { repo, remote, token: { token: "gs_..." } }
 *
 * git remote add origin "https://x:gs_...@<host>/acme/web.git"
 * git push origin main
 * ```
 */
import * as Cloudflare from "../Cloudflare/index.ts";
import crypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import type * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import type * as HttpApi from "effect/unstable/httpapi/HttpApi";
import type * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as Http from "../Http/index.ts";
import {
  CommitDiff,
  CommitInfo,
  Comparison,
  DiffEntry,
  GitApi,
  HookRejected,
  InternalApi,
  // routes
  Compare,
  CompactRepo,
  CreatePull,
  CreateRepo,
  DeleteRepo,
  ForkRepo,
  GetBlob,
  GetBlobRaw,
  GetCommit,
  GetDiff,
  GetFile,
  GetLog,
  GetPull,
  GetRef,
  GetRepo,
  GetTree,
  GitHubBranches,
  GitHubCommit,
  GitHubCommits,
  GitHubContents,
  GitHubCreatePull,
  GitHubMergePull,
  GitHubPull,
  GitHubPullFiles,
  GitHubPulls,
  GitHubRepo,
  GitHubUpdatePull,
  GitHubUser,
  HashPart,
  ImportRepo,
  InfoRefs,
  ListPulls,
  ListRefs,
  ListRepos,
  MergePull,
  ReceivePack,
  RemoveRef,
  UpdatePull,
  UpdateRef,
  UpdateRepo,
  UploadPack,
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
  TreeEntry,
  type Oid,
} from "./Api.ts";
import { Hooks, type HooksShape, type RefUpdate } from "./Hooks.ts";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import { gitHubCompatRoutes } from "./GitHubCompat.ts";
import { BlobStore, type BlobStoreError } from "./BlobStore.ts";
import { bundleCovers, type BundleInfo } from "./Jobs/Bundle.ts";
import { headKey } from "./Store/Keys.ts";
import { decodeHeadSnapshot } from "./Store/HeadSnapshot.ts";
import {
  concatBytes,
  parseCommit,
  parseTree,
  treeEntryKind,
  utf8Decode,
  ZERO_OID,
  type ObjectType,
} from "./Protocol/ObjectCodec.ts";
import { ulid } from "./RegistryObject.ts";
import { decodePktLines, errPkt, flushPkt, pktText } from "./Protocol/Pkt.ts";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { Hasher } from "./Hasher/Hasher.ts";
import { encodeStagedBatch } from "./PushWire.ts";
import { feedBody, HEAD_BYTES } from "./Store/IncomingBody.ts";
import { makeStreamingSource } from "./Store/StreamingSource.ts";
import { sliceRandomAccess } from "./Store/PackSource.ts";
import { incomingKey, wirePackId } from "./Store/Keys.ts";
import { StoreError as StoreErrorClass } from "./Protocol/Store.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import {
  progressMessage,
  pumpPackBody,
  sidebandFrames,
  wrapSideband,
} from "./Protocol/Sideband.ts";
import {
  decodeBoundsRequest,
  encodeScanResult,
  frame,
  HASHER_BINDING,
  InternalSecret,
} from "./Hasher/Hasher.ts";
import { decodeDeltaBatch, encodeDeltaResults } from "./Hasher/Protocol.ts";
import { hashBounds, resolveDeltas, scanPart } from "./Protocol/PartialScan.ts";
import type { StoreError } from "./Protocol/Store.ts";
import {
  buildAdvertisement,
  parseUploadPackRequest,
  BUNDLE_COUNT_HEADER,
  BUNDLE_HASH_HEADER,
  BUNDLE_KEY_HEADER,
  BUNDLE_SIDEBAND_HEADER,
  GitRepo,
  GitRepoLive,
  RepoStore,
  WWW_AUTHENTICATE,
  gunzipIfNeeded,
  ingestPackFrom,
  isolatePushGate,
  MAX_PACK_BYTES,
  parseReceivePackRequest,
  PUSH_WAIT_TIMEOUT,
  pushPermitsFor,
  type IngestResult,
  type IngestStore,
  type CommitData,
  type DiffEntryData,
  type PullData,
  type PullDetailData,
  type RefData,
  type RepoMetaData,
  type RepoStub,
} from "./RepoObject.ts";
import { RegistryStore, type RegistryEntry } from "./RegistryObject.ts";

/** A `Bearer` credential from the `Authorization` header (the hash route's internal secret). */
const parseBearer = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const authorization = headers.authorization;
  if (authorization === undefined) return undefined;
  const space = authorization.indexOf(" ");
  if (space === -1) return undefined;
  if (authorization.slice(0, space).toLowerCase() !== "bearer")
    return undefined;
  const credential = authorization.slice(space + 1).trim();
  return credential === "" ? undefined : credential;
};

const sha256 = (input: string): Uint8Array => {
  const digest = crypto.createHash("sha256").update(input).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
};

/** Timing-safe string equality over sha-256 digests. */
const timingSafeEqual = (a: string, b: string): Effect.Effect<boolean> =>
  Effect.sync(() => crypto.timingSafeEqual(sha256(a), sha256(b)));

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** TTL of the in-isolate `owner/name → repoId` cache (DESIGN.md §2.1). */
export const RESOLVE_CACHE_TTL_MS = 60_000;

/** Max entries of the in-isolate resolve cache (insertion-order eviction). */
export const RESOLVE_CACHE_MAX = 1024;

/** Blobs above this size are 422 on the JSON endpoint (use `/raw`). */
export const MAX_JSON_BLOB_BYTES = 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Shared layers
// ─────────────────────────────────────────────────────────────────────────────

/** Types a route's handler against its route class. */
const impl = <R extends HttpApiEndpoint.Constraint>(
  _route: R,
  handler: Http.Handler<R>,
): Http.Handler<R> => handler;

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
  // The push pipeline hashes each spilled part in a fresh isolate of this
  // same script through a self service binding (DESIGN §22.7, Hasher.ts).
  env: { [HASHER_BINDING]: Cloudflare.Workers.Self },
};

const makeCore = Effect.gen(function* () {
  // ── init: DO namespaces ────────────────────────────────────────────────
  // RPC-boundary tagged errors are reconstructed by the stubs themselves —
  // both DO classes declare `errors: [...]` (see DurableObjectProps.errors).
  const registry = yield* RegistryStore;
  const repos = yield* RepoStore;
  // The Worker streams clone bundles straight out of R2 (DESIGN.md §11):
  // the DO plans the clone, the bytes bypass it entirely.
  // The Worker-side view of the blob store (clone-bundle splice reads)
  // — the same BlobStore layer the Repo DO consumes.
  const workerBlobs = yield* BlobStore;
  // git's pre-receive hook, if the graph provides one; accepts everything
  // otherwise. Runs here in the Worker, inside the request.
  const hooks: HooksShape = Option.getOrElse(
    yield* Effect.serviceOption(Hooks),
    () => ({ preReceive: () => Effect.succeed([]) }),
  );
  const internalSecret = yield* InternalSecret;
  // The push pipeline's verifier (DESIGN §22.10): pack parts are inflated
  // and hashed by this service — fanned out across Worker invocations by
  // `HasherSelf`, inline under `HasherInline`.
  const hasher = yield* Hasher;
  const pushGate = yield* isolatePushGate;
  /** Staging batches in flight to the Repo DO per push (DESIGN §22.10). */
  const STAGE_CONCURRENCY = 6;

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

  /**
   * git's pre-receive hook over a REST ref write or a merge: the same
   * question the push path asks, with the one update it would make.
   */
  const preReceive = (
    stub: RepoStub,
    params: { readonly owner: string; readonly repo: string },
    updates: ReadonlyArray<RefUpdate>,
  ) =>
    Effect.gen(function* () {
      const meta = yield* stub.readMeta().pipe(
        Effect.catchTag("StoreError", (error) => Effect.die(error)),
        Effect.catchTag("RepoNotFound", () =>
          Effect.fail(new RepoNotFound(params)),
        ),
      );
      const rejections = yield* hooks.preReceive({ repo: meta, updates });
      const first = rejections[0];
      if (first !== undefined) {
        return yield* new HookRejected({
          ref: first.ref,
          reason: first.reason,
        });
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
              .readMeta()
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

  const reposRoutes = {
    create: impl(CreateRepo, ({ payload }) =>
      Effect.gen(function* () {
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
        });
      }),
    ),
    get: impl(GetRepo, ({ params }) =>
      Effect.gen(function* () {
        // Includes rows mid-purge: GET keeps reporting
        // status "deleting" until the purge alarm frees the name (only
        // then a 404), so "poll GET until 404 then re-create" never
        // races the purge.
        const entry = yield* resolveIncludingDeleting(
          params.owner,
          params.repo,
        );
        if (entry.deletedAt !== null) {
          return registryFallbackRepo(entry);
        }
        const meta = yield* repos
          .getByName(entry.repoId)
          .getRepoMeta()
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
    ),
    update: impl(UpdateRepo, ({ params, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const meta = yield* repos
          .getByName(entry.repoId)
          .updateRepoMeta({
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
    ),
    list: impl(ListRepos, ({ query }) =>
      Effect.gen(function* () {
        // Everything the Registry holds; `public: true` narrows it. Who
        // may list at all was decided in front of the route.
        const page = yield* registryStub()
          .list({
            owner: query.owner,
            cursor: query.cursor,
            limit: query.limit,
            publicOnly: query.public === true,
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
    ),
    delete: impl(DeleteRepo, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveIncludingDeleting(
          params.owner,
          params.repo,
        );
        // Always (re-)arm the purge — even when the row is already
        // soft-deleted. A second DELETE mid-drain is an idempotent 204,
        // and re-arming is what recovers a purge whose alarm was lost
        // (crash between markDeleted and the first alarm run).
        yield* repos
          .getByName(entry.repoId)
          .startPurge()
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
    ),
    fork: impl(ForkRepo, ({ params, payload }) =>
      Effect.gen(function* () {
        const source = yield* resolveOrNotFound(params.owner, params.repo);
        const sourceMeta = yield* repos
          .getByName(source.repoId)
          .readMeta()
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
        });
      }),
    ),
    compact: impl(CompactRepo, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        yield* repos
          .getByName(entry.repoId)
          .startCompact()
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
    import: impl(ImportRepo, ({ payload }) =>
      Effect.gen(function* () {
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
        });
      }),
    ),
  };

  const refsRoutes = {
    list: impl(ListRefs, ({ params, query }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .listRefs(query.prefix)
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
        return { head: page.head, refs: page.refs.map(toRef) };
      }),
    ),
    get: impl(GetRef, ({ params, query }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const ref = yield* repos
          .getByName(entry.repoId)
          .getRef(query.name)
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
    ),
    update: impl(UpdateRef, ({ params, query, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        const current = yield* stub.getRef(query.name).pipe(
          Effect.map((ref) => ref.oid),
          Effect.catchTag("RefNotFound", () => Effect.succeed(ZERO_OID)),
          Effect.catchTag("StoreError", (error) => Effect.die(error)),
          Effect.catchTag("RepoNotFound", () =>
            Effect.fail(new RepoNotFound(params)),
          ),
        );
        yield* preReceive(stub, params, [
          { ref: query.name, oldOid: current, newOid: payload.newOid },
        ]);
        const ref = yield* stub
          .updateRef({
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
    ),
    remove: impl(RemoveRef, ({ params, query, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        const current = yield* stub.getRef(query.name).pipe(
          Effect.map((ref) => ref.oid),
          Effect.catchTag("StoreError", (error) => Effect.die(error)),
          Effect.catchTag("RepoNotFound", () =>
            Effect.fail(new RepoNotFound(params)),
          ),
        );
        yield* preReceive(stub, params, [
          { ref: query.name, oldOid: current, newOid: ZERO_OID },
        ]);
        yield* stub
          .removeRef({
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
  };

  const objectsRoutes = {
    commit: impl(GetCommit, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "commit" })
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
    ),
    log: impl(GetLog, ({ params, query }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .readCommitLog({
            ref: query.ref,
            cursor: query.cursor,
            limit: query.limit,
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
        return {
          items: page.items.map(toCommitInfo),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      }),
    ),
    tree: impl(GetTree, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "tree" })
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
    ),
    blob: impl(GetBlob, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readObject({ oid: params.oid, expect: "blob" })
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
    diff: impl(GetDiff, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .readCommitDiff({ oid: params.oid })
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
        return new CommitDiff({
          oid: params.oid,
          parent: data.parent === null ? null : asOid(data.parent),
          files: data.files.map(toDiffEntry),
          truncated: data.truncated,
        });
      }),
    ),
    compare: impl(Compare, ({ params, query }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const data = yield* repos
          .getByName(entry.repoId)
          .compareCommits({ base: query.base, head: query.head })
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
  };

  const pullsRoutes = {
    create: impl(CreatePull, ({ params, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const pull = yield* repos
          .getByName(entry.repoId)
          .createPull({
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
    ),
    list: impl(ListPulls, ({ params, query }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const page = yield* repos
          .getByName(entry.repoId)
          .listPulls({
            state: query.state,
            cursor: query.cursor,
            limit: query.limit,
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
        return {
          items: page.items.map(toPull),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      }),
    ),
    get: impl(GetPull, ({ params }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const detail = yield* repos
          .getByName(entry.repoId)
          .getPull(params.number)
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
        return toPullDetail(detail);
      }),
    ),
    update: impl(UpdatePull, ({ params, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const pull = yield* repos
          .getByName(entry.repoId)
          .updatePull({
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
    ),
    merge: impl(MergePull, ({ params, payload }) =>
      Effect.gen(function* () {
        const entry = yield* resolveOrNotFound(params.owner, params.repo);
        const stub = repos.getByName(entry.repoId);
        // The hook sees the base branch moving to the head tip. A merge
        // commit's oid does not exist until the merge is written, so a
        // hook that must see it decorates `RepoStore` instead.
        const pull = yield* stub.getPull(params.number).pipe(
          Effect.catchTag("StoreError", (error) => Effect.die(error)),
          Effect.catchTag("RepoNotFound", () =>
            Effect.fail(new RepoNotFound(params)),
          ),
        );
        yield* preReceive(stub, params, [
          {
            ref: pull.baseRef,
            oldOid: pull.baseOid ?? ZERO_OID,
            newOid: pull.headOid ?? ZERO_OID,
          },
        ]);
        const result = yield* stub
          .mergePull({
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
  };

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
   * The DO-less read path (DESIGN.md §21): the upload-pack
   * advertisement and bundle-covered full clones served straight from
   * the repo's head snapshot in the BlobStore — the Repo DO never
   * wakes, so read throughput scales with Workers + blob storage
   * instead of one single-threaded object.
   *
   * `undefined` = not eligible; the caller forwards to the DO. Access
   * was decided before the route ran, by the middleware of the API
   * that mounts it — this changes WHERE the bytes come from, never who
   * gets them.
   */
  const headSnapshotFastPath = Effect.fn(function* (
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

    const resolved = yield* Effect.result(resolveCached(owner, repo));
    if (Result.isFailure(resolved)) {
      return internalError;
    }
    const entry = resolved.success;
    if (entry === undefined) {
      return notFound;
    }

    // Reads never wake the DO when the head snapshot covers them: the
    // middleware in front of the route already decided who may read.
    const fast = yield* headSnapshotFastPath(request, entry.repoId);
    if (fast !== undefined) return fast;

    const response = yield* repos.getByName(entry.repoId).fetch(request);

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

  /**
   * POST git-receive-pack — the push pipeline (DESIGN §22.10). It runs
   * HERE, in the stateless Worker: the body streams into the hasher
   * fan-out and the blob-store spill as it arrives, and the Repo DO
   * receives only staged ROWS (`stagePush`, promoted rows are coordinates
   * into the wire pack) and the commit summary (`commitPush`). No pack
   * byte enters the Durable Object, so its memory, CPU and egress are
   * untouched by push size.
   */
  const receivePackRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const owner = (params.owner ?? "").toLowerCase();
    let repo = (params.repo ?? "").toLowerCase();
    if (repo.endsWith(".git")) repo = repo.slice(0, -4);
    const resolved = yield* Effect.result(resolveCached(owner, repo));
    if (Result.isFailure(resolved)) return internalError;
    const entry = resolved.success;
    if (entry === undefined) return notFound;
    const stub = repos.getByName(entry.repoId);
    const resultType = "application/x-git-receive-pack-result";
    const noCache = { "cache-control": "no-cache" } as const;
    const reply = (bytes: Uint8Array) =>
      HttpServerResponse.uint8Array(bytes, {
        contentType: resultType,
        headers: noCache,
      });
    const asStoreError = (error: {
      readonly _tag: string;
      readonly reason?: string;
    }) =>
      error instanceof StoreErrorClass
        ? error
        : new StoreErrorClass({
            reason: `${error._tag}${error.reason === undefined ? "" : `: ${error.reason}`}`,
          });

    // Declared before the receive so every exit path drops the spilled
    // object through the single `ensuring` at the bottom — unless staged
    // rows reference it as a wire pack, in which case it is repo data.
    let parkedKey: string | undefined;
    let resolvedKey: string | undefined;
    let keepParked = false;
    const receiveId = yield* ulid();
    const feeder = makeStreamingSource();
    // Staging batches in flight to the DO. Detached from the pump's
    // fibers (a consumer's children would die with it); the route joins
    // them before the commit and interrupts leftovers on any other exit.
    const staging: Array<Fiber.Fiber<void, StoreErrorClass>> = [];
    const isGzip = /\bgzip\b/i.test(request.headers["content-encoding"] ?? "");
    const receiving = yield* Effect.forkChild(
      Effect.result(
        isGzip
          ? Effect.gen(function* () {
              // gzip bodies are small by git's own rules: collect, inflate,
              // feed.
              const raw = yield* Stream.runCollect(request.stream).pipe(
                Effect.map((chunks) => concatBytes(Array.from(chunks))),
                Effect.mapError(
                  (error) =>
                    new StoreErrorClass({
                      reason: `incoming body read: ${String(error)}`,
                    }),
                ),
              );
              const decoded = yield* gunzipIfNeeded(
                raw,
                request.headers["content-encoding"],
              ).pipe(
                Effect.mapError(
                  (error) => new StoreErrorClass({ reason: error.reason }),
                ),
              );
              yield* feeder.push(decoded);
              feeder.end();
              return { total: decoded.length };
            }).pipe(
              Effect.tapError((error) => Effect.sync(() => feeder.fail(error))),
            )
          : Effect.flatMap(
              HttpServerRequest.toWeb(request).pipe(
                Effect.mapError(
                  (error) =>
                    new StoreErrorClass({
                      reason: `incoming body: ${String(error)}`,
                    }),
                ),
              ),
              (web) => feedBody(web.body, feeder),
            ),
      ),
    );
    return yield* Effect.gen(function* () {
      // The pkt-line command section precedes the pack and is small.
      const headResult = yield* Effect.result(
        feeder.source.read(0, HEAD_BYTES),
      );
      if (Result.isFailure(headResult)) {
        return reply(errPkt(headResult.failure.reason));
      }
      const body = headResult.success;
      if (!isGzip && body[0] === 0x1f && body[1] === 0x8b) {
        return reply(errPkt("gzip-encoded push without content-encoding"));
      }
      const parsedResult = yield* Effect.result(parseReceivePackRequest(body));
      if (Result.isFailure(parsedResult)) {
        return reply(errPkt(parsedResult.failure.reason));
      }
      const parsed = parsedResult.success;
      if (parsed.probe) {
        // git's empty-flush probe when the payload exceeds http.postBuffer:
        // reply empty 200 so it retries with the body.
        return HttpServerResponse.empty({
          status: 200,
          headers: { ...noCache, "content-type": resultType },
        });
      }
      const sideband = parsed.capabilities.has("side-band-64k");
      const wantReport =
        parsed.capabilities.has("report-status") ||
        parsed.capabilities.has("report-status-v2");
      const respond = (
        unpack: string,
        results: ReadonlyArray<{
          readonly ref: string;
          readonly ok: boolean;
          readonly reason?: string | undefined;
        }>,
      ) => {
        if (!wantReport) {
          return HttpServerResponse.empty({
            status: 200,
            headers: { ...noCache, "content-type": resultType },
          });
        }
        const lines: Array<Uint8Array> = [pktText(`unpack ${unpack}`)];
        for (const result of results) {
          lines.push(
            result.ok
              ? pktText(`ok ${result.ref}`)
              : pktText(`ng ${result.ref} ${result.reason ?? "failed"}`),
          );
        }
        lines.push(flushPkt);
        const report = concatBytes(lines);
        return reply(
          sideband
            ? concatBytes([...sidebandFrames(1, report), flushPkt])
            : report,
        );
      };
      const allNg = (reason: string) =>
        parsed.commands.map((cmd) => ({ ref: cmd.ref, ok: false, reason }));

      // The pre-receive hook, with the parsed ref updates: a refusal is
      // reported per ref and nothing moves.
      const meta = yield* stub.readMeta().pipe(
        Effect.catchTag("StoreError", (error) => Effect.die(error)),
        Effect.catchTag("RepoNotFound", () => Effect.succeed(undefined)),
      );
      if (meta === undefined) return notFound;
      const rejections = yield* hooks.preReceive({
        repo: meta,
        updates: parsed.commands,
      });
      if (rejections.length > 0) {
        return respond(
          "ok",
          parsed.commands.map((cmd) => ({
            ref: cmd.ref,
            ok: false,
            reason:
              rejections.find((r) => r.ref === cmd.ref)?.reason ??
              "rejected by hook",
          })),
        );
      }

      // Phase 1 in the DO: read-only check and the staging push row.
      const routeStarted = Date.now();
      const begun = yield* stub.beginPush({ commands: parsed.commands });
      const beginMs = Date.now() - routeStarted;
      if (begun._tag === "denied") return respond("ok", allNg(begun.reason));
      const pushId = begun.pushId;

      // Admission by ingest memory (DESIGN.md §2.1): small pushes run
      // concurrently; only genuinely large bodies contend. ≤ 30 s, then 503.
      const declared = Number.parseInt(
        request.headers["content-length"] ?? "",
        10,
      );
      const permits = pushPermitsFor(
        Number.isNaN(declared) ? undefined : declared,
      );
      const permit = yield* Semaphore.take(pushGate, permits).pipe(
        Effect.timeoutOption(PUSH_WAIT_TIMEOUT),
      );
      if (Option.isNone(permit)) {
        return HttpServerResponse.empty({
          status: 503,
          headers: { "retry-after": "10" },
        });
      }
      return yield* Effect.gen(function* () {
        const startedAt = yield* Effect.sync(() => performance.now());
        const since = (from: number) =>
          Effect.sync(() => performance.now() - from);
        // The DO's store surface over RPC: rows go across as encoded
        // batches; thin-delta bases come back cached per push.
        const bases = new Map<
          string,
          | { readonly type: ObjectType; readonly content: Uint8Array }
          | undefined
        >();
        // Staging batches go to the DO concurrently (bounded) so the round
        // trips overlap the receive; `settle` joins them before the commit.
        const stageGate = yield* Semaphore.make(STAGE_CONCURRENCY);
        const store: IngestStore = {
          insertStagedBatch: (id, objects) =>
            Effect.gen(function* () {
              // Encoded now (a copy), so the caller may release its buffers.
              const encoded = encodeStagedBatch(objects);
              const fiber = yield* Effect.forkDetach(
                Semaphore.withPermits(
                  stageGate,
                  1,
                )(
                  stub
                    .stagePush(id, encoded)
                    .pipe(
                      Effect.mapError(asStoreError),
                      Effect.provide(RuntimeContext.phantom),
                    ),
                ),
              );
              staging.push(fiber);
            }),
          settle: Effect.gen(function* () {
            for (const fiber of staging.splice(0)) yield* Fiber.join(fiber);
          }),
          readBase: (oid) =>
            bases.has(oid)
              ? Effect.succeed(bases.get(oid))
              : stub.readPushBase(oid).pipe(
                  Effect.mapError(asStoreError),
                  Effect.tap((found) =>
                    Effect.sync(() => {
                      bases.set(oid, found);
                    }),
                  ),
                  Effect.provide(RuntimeContext.phantom),
                ),
        };
        // Is there a pack at all? A delete-only push ends right after the
        // commands. This waits only for 12 bytes (or the end).
        const probe = yield* feeder.source
          .read(parsed.packStart, 12)
          .pipe(Effect.result);
        const hasPack = Result.isSuccess(probe) && probe.success.length === 12;
        let ingest: IngestResult | undefined;
        let ingestMs = 0;
        if (hasPack) {
          const source = sliceRandomAccess(feeder.source, parsed.packStart);
          const ingestStarted = yield* Effect.sync(() => performance.now());
          const outcome = yield* Effect.result(
            ingestPackFrom(source, {
              store,
              pushId,
              hasher,
              spill: {
                body: feeder.source,
                feeder,
                packStart: parsed.packStart,
                blobs: workerBlobs,
                key: incomingKey(entry.repoId, receiveId),
                packId: wirePackId(receiveId),
                repoId: entry.repoId,
                threshold: MAX_PACK_BYTES,
              },
            }),
          );
          ingestMs = yield* since(ingestStarted);
          if (Result.isFailure(outcome)) {
            yield* Effect.logError("push ingest failed", outcome.failure);
            return respond(outcome.failure.reason, allNg("unpacker error"));
          }
          ingest = outcome.success;
        }
        // The body has been fully consumed (the parser read through the
        // trailer); wait for the spill to complete before the rows that
        // reference it can be committed.
        const received = yield* Fiber.join(receiving);
        if (Result.isFailure(received)) {
          return reply(errPkt(received.failure.reason));
        }
        parkedKey = ingest?.parkedKey;
        resolvedKey = ingest?.resolvedKey;
        const promoted = ingest?.promoted ?? 0;
        const commitStarted = Date.now();
        const committed = yield* stub.commitPush({
          pushId,
          commands: parsed.commands,
          atomic: parsed.capabilities.has("atomic"),
          commits: ingest?.commits ?? [],
          referenced: ingest?.referenced ?? [],
          referencedParents: ingest?.referencedParents ?? [],
          promoted,
          stats: {
            objects: ingest?.objectCount ?? 0,
            bytes: hasPack ? received.success.total - parsed.packStart : 0,
            ingestMs,
            stageMs: ingest?.stageMs ?? 0,
            phases: {
              ...ingest?.phases,
              begin: beginMs,
              ingestAt: commitStarted - routeStarted,
            },
          },
        });
        console.log(
          `[push] begin=${beginMs}ms ingest=${Math.round(ingestMs)}ms commit=${Date.now() - commitStarted}ms total=${Date.now() - routeStarted}ms`,
        );
        if (
          promoted > 0 &&
          parkedKey !== undefined &&
          committed.results.some((r) => r.ok)
        ) {
          keepParked = true;
        }
        void startedAt;
        return respond(committed.unpack, committed.results);
      }).pipe(Effect.ensuring(Semaphore.release(pushGate, permits)));
    }).pipe(
      Effect.catchTag("StoreError", (error) =>
        Effect.as(
          Effect.logError("push: storage failure", error),
          reply(errPkt(error.reason)),
        ),
      ),
      Effect.catchTag("RepoNotFound", () => Effect.succeed(notFound)),
      Effect.tapCause((cause) => Effect.logError("push: route failure", cause)),
      // Single owner of the spilled body: whatever path exits, the parked
      // object is dropped unless committed rows reference it.
      Effect.ensuring(
        Effect.andThen(
          Effect.andThen(Fiber.interrupt(receiving), () =>
            Fiber.interruptAll(staging.splice(0)),
          ),
          () => {
            const keys = keepParked
              ? []
              : [parkedKey, ...(resolvedKey?.split(",") ?? [])].filter(
                  (key): key is string => key !== undefined && key !== "",
                );
            return keys.length === 0
              ? Effect.void
              : workerBlobs
                  .delete(keys)
                  .pipe(Effect.provide(RuntimeContext.phantom), Effect.ignore);
          },
        ),
      ),
    );
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
      return { kind: "ok", entry: resolved.success } as const;
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
      .readObject({ oid: params.oid ?? "", expect: "blob" })
      .pipe(
        Effect.map((data) =>
          HttpServerResponse.uint8Array(data.content, {
            contentType: "application/octet-stream",
          }),
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
      .readFileAtPath({ ref, path })
      .pipe(
        Effect.map((file) =>
          HttpServerResponse.uint8Array(file.content, {
            contentType: "application/octet-stream",
          }),
        ),
        Effect.catchTag(["RepoNotFound", "RefNotFound", "ObjectNotFound"], () =>
          Effect.succeed(HttpServerResponse.text("not found", { status: 404 })),
        ),
        Effect.catchTag("StoreError", () => Effect.succeed(internalError)),
      );
  });

  // GitHub REST v3 compatibility facade (`gh api`, Octokit): reuses the
  // same prelude + DO stubs; auth enforcement stays in the DO.
  const githubRoutes = gitHubCompatRoutes({
    prelude: rawRestPrelude,
    stub: (repoId) => repos.getByName(repoId),
  });

  /**
   * The push pipeline's hashing endpoint (DESIGN §22.7): a spilled part (plus
   * carry) in the body, coordinates in the query; the scan result in the
   * binary form `Hasher.ts` decodes. Internal: admin-authenticated, reached
   * through the self service binding.
   */
  const hashPartRoute = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const presented = parseBearer(request.headers);
    const expected = Redacted.value(yield* internalSecret);
    if (
      presented === undefined ||
      !(yield* timingSafeEqual(presented, expected))
    ) {
      return HttpServerResponse.text("forbidden", { status: 403 });
    }
    const query = new URL(request.url, "http://x").searchParams;
    const base = Number(query.get("base"));
    const maxObjectSize = Number(query.get("max"));
    const boundsMode = query.get("mode") === "bounds";
    const remaining = boundsMode ? 0 : Number(query.get("remaining"));
    if (![base, remaining, maxObjectSize].every(Number.isFinite)) {
      return HttpServerResponse.text("bad coordinates", { status: 400 });
    }
    const t0 = Date.now();
    const body = new Uint8Array(yield* request.arrayBuffer);
    const tBody = Date.now();
    if (query.get("mode") === "deltas") {
      const { bases, jobs } = decodeDeltaBatch(body);
      const resolved = yield* resolveDeltas(bases, jobs, {
        maxObjectSize,
      }).pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        return HttpServerResponse.text(
          `${resolved.failure._tag}: ${"reason" in resolved.failure ? resolved.failure.reason : ""}`,
          { status: 422 },
        );
      }
      return HttpServerResponse.uint8Array(
        frame(encodeDeltaResults(resolved.success)),
        { contentType: "application/octet-stream" },
      );
    }
    // A requested spill part uploads concurrently with the scan (DESIGN
    // §22.10): this isolate is the writer of the part it verifies.
    const key = query.get("key");
    const uploadId = query.get("uploadId");
    const partNumber = Number(query.get("part"));
    const upload =
      key !== null && uploadId !== null && Number.isFinite(partNumber)
        ? // Detached: it outlives the handler fiber, which returns as soon as
          // the scan is written; the open response stream keeps the
          // invocation alive until the part frame follows.
          yield* Effect.forkDetach(
            workerBlobs
              .uploadPart(key, uploadId, partNumber, body)
              .pipe(Effect.provide(RuntimeContext.phantom), Effect.result),
          )
        : undefined;
    const skip = Number(query.get("skip") ?? "0");
    const result = yield* (
      boundsMode
        ? Effect.suspend(() => {
            const { bounds, payload } = decodeBoundsRequest(body);
            return hashBounds(payload, bounds, { base, maxObjectSize });
          })
        : scanPart(skip > 0 ? body.subarray(skip) : body, {
            base,
            remaining,
            maxObjectSize,
            resync: query.get("resync") === "1",
          })
    ).pipe(Effect.result);
    if (Result.isFailure(result)) {
      return HttpServerResponse.text(
        `${result.failure._tag}: ${"reason" in result.failure ? result.failure.reason : ""}`,
        { status: 422 },
      );
    }
    const scanFrame = frame(encodeScanResult(result.success));
    if (upload === undefined) {
      return HttpServerResponse.uint8Array(scanFrame, {
        contentType: "application/octet-stream",
      });
    }
    // Two frames: the scan now, the part once its upload has finished —
    // the open response stream keeps this invocation alive meanwhile.
    const { readable, writable } = new IdentityTransformStream();
    const tScan = Date.now();
    // A plain async writer, like the clone pump: writes settle only as the
    // response is read, and the open stream keeps this invocation alive
    // until the part's upload has finished.
    const partDone = Effect.runPromise(Fiber.join(upload));
    yield* Effect.sync(() => {
      void (async () => {
        const writer = writable.getWriter();
        try {
          await writer.write(scanFrame);
          const part = await partDone;
          if (body.length > 1 << 20) {
            console.log(
              `[hash] bytes=${body.length} body=${tBody - t0}ms scan=${tScan - tBody}ms upload=${Date.now() - tScan}ms part=${partNumber}`,
            );
          }
          if (Result.isFailure(part)) {
            await writable
              .abort(new Error(part.failure.reason))
              .catch(() => {});
            return;
          }
          await writer.write(
            frame(new TextEncoder().encode(JSON.stringify(part.success))),
          );
          await writer.close();
        } catch (error) {
          await writable.abort(error).catch(() => {});
        }
      })();
    });
    return HttpServerResponse.raw(readable, {
      contentType: "application/octet-stream",
    });
  });

  return {
    repos: reposRoutes,
    refs: refsRoutes,
    objects: objectsRoutes,
    pulls: pullsRoutes,
    raw: {
      blobRaw: impl(GetBlobRaw, () => blobRawRoute),
      file: impl(GetFile, () => fileRoute),
    },
    protocol: {
      infoRefs: impl(InfoRefs, () => wireProxy),
      uploadPack: impl(UploadPack, () => wireProxy),
      receivePack: impl(ReceivePack, () => receivePackRoute),
      hashPart: impl(HashPart, () => hashPartRoute),
    },
    github: githubRoutes,
  };
});

/**
 * The engine's HTTP planes as pieces, built once per Worker and shared by
 * every route below (the resolve cache, the DO stubs, the push gate).
 * Internal: users compose the routes, never the core.
 */
class Core extends Context.Service<Core, Effect.Success<typeof makeCore>>()(
  "alchemy/Git/Core",
) {}
const CoreLive = Layer.effect(Core, makeCore);

/** A route's default implementation: the core's handler for it. */
const live = <
  R extends HttpApiEndpoint.Constraint & Http.RouteStatics<any, any>,
>(
  route: R,
  pick: (core: Effect.Success<typeof makeCore>) => Http.Handler<R>,
): Layer.Layer<R["~Route"], never, Layer.Services<typeof CoreLive>> =>
  route
    .make(Effect.map(Core, pick) as Effect.Effect<any, never, Core>)
    .pipe(Layer.provide(CoreLive));

// ── the default implementation of every route ────────────────────────────────
// Each is `Route.make(...)` over the shared core, so any one of them can be
// replaced by providing another Layer for the same route nearer the API.
export const CreateRepoLive = live(CreateRepo, (core) => core.repos.create);
export const GetRepoLive = live(GetRepo, (core) => core.repos.get);
export const UpdateRepoLive = live(UpdateRepo, (core) => core.repos.update);
export const ListReposLive = live(ListRepos, (core) => core.repos.list);
export const DeleteRepoLive = live(DeleteRepo, (core) => core.repos.delete);
export const ForkRepoLive = live(ForkRepo, (core) => core.repos.fork);
export const ImportRepoLive = live(ImportRepo, (core) => core.repos.import);
export const CompactRepoLive = live(CompactRepo, (core) => core.repos.compact);
export const ListRefsLive = live(ListRefs, (core) => core.refs.list);
export const GetRefLive = live(GetRef, (core) => core.refs.get);
export const UpdateRefLive = live(UpdateRef, (core) => core.refs.update);
export const RemoveRefLive = live(RemoveRef, (core) => core.refs.remove);
export const GetCommitLive = live(GetCommit, (core) => core.objects.commit);
export const GetLogLive = live(GetLog, (core) => core.objects.log);
export const GetTreeLive = live(GetTree, (core) => core.objects.tree);
export const GetBlobLive = live(GetBlob, (core) => core.objects.blob);
export const GetDiffLive = live(GetDiff, (core) => core.objects.diff);
export const CompareLive = live(Compare, (core) => core.objects.compare);
export const GetBlobRawLive = live(GetBlobRaw, (core) => core.raw.blobRaw);
export const GetFileLive = live(GetFile, (core) => core.raw.file);
export const CreatePullLive = live(CreatePull, (core) => core.pulls.create);
export const ListPullsLive = live(ListPulls, (core) => core.pulls.list);
export const GetPullLive = live(GetPull, (core) => core.pulls.get);
export const UpdatePullLive = live(UpdatePull, (core) => core.pulls.update);
export const MergePullLive = live(MergePull, (core) => core.pulls.merge);
export const InfoRefsLive = live(InfoRefs, (core) => core.protocol.infoRefs);
export const UploadPackLive = live(
  UploadPack,
  (core) => core.protocol.uploadPack,
);
export const ReceivePackLive = live(
  ReceivePack,
  (core) => core.protocol.receivePack,
);
export const HashPartLive = live(HashPart, (core) => core.protocol.hashPart);
export const GitHubUserLive = live(GitHubUser, (core) => core.github.user);
export const GitHubRepoLive = live(GitHubRepo, (core) => core.github.repo);
export const GitHubBranchesLive = live(
  GitHubBranches,
  (core) => core.github.branches,
);
export const GitHubCommitsLive = live(
  GitHubCommits,
  (core) => core.github.commits,
);
export const GitHubCommitLive = live(
  GitHubCommit,
  (core) => core.github.commit,
);
export const GitHubContentsLive = live(
  GitHubContents,
  (core) => core.github.contents,
);
export const GitHubPullsLive = live(GitHubPulls, (core) => core.github.pulls);
export const GitHubCreatePullLive = live(
  GitHubCreatePull,
  (core) => core.github.createPull,
);
export const GitHubPullLive = live(GitHubPull, (core) => core.github.pull);
export const GitHubUpdatePullLive = live(
  GitHubUpdatePull,
  (core) => core.github.updatePull,
);
export const GitHubMergePullLive = live(
  GitHubMergePull,
  (core) => core.github.mergePull,
);
export const GitHubPullFilesLive = live(
  GitHubPullFiles,
  (core) => core.github.pullFiles,
);

/**
 * The default implementation of every git route: provide it to
 * `Http.handlers(api)` for any API derived from {@link GitApi}. Requires
 * the storage blocks; the API's middleware is required by the routes
 * themselves, through `Http.handlers`. A Layer provided nearer than
 * `Handlers` overrides the route it implements.
 *
 * ```typescript
 * Git.Server.layer(AppApi).pipe(
 *   Layer.provide([MeLive, GitHubUserBetterAuth]), // yours, and one override
 *   Layer.provide(Git.Handlers),
 *   Layer.provide(SessionLive), // the middleware AppApi declares
 * )
 * ```
 */
export const Handlers = Layer.mergeAll(
  CreateRepoLive,
  GetRepoLive,
  UpdateRepoLive,
  ListReposLive,
  DeleteRepoLive,
  ForkRepoLive,
  ImportRepoLive,
  CompactRepoLive,
  ListRefsLive,
  GetRefLive,
  UpdateRefLive,
  RemoveRefLive,
  GetCommitLive,
  GetLogLive,
  GetTreeLive,
  GetBlobLive,
  GetDiffLive,
  CompareLive,
  GetBlobRawLive,
  GetFileLive,
  CreatePullLive,
  ListPullsLive,
  GetPullLive,
  UpdatePullLive,
  MergePullLive,
  InfoRefsLive,
  UploadPackLive,
  ReceivePackLive,
  HashPartLive,
  GitHubUserLive,
  GitHubRepoLive,
  GitHubBranchesLive,
  GitHubCommitsLive,
  GitHubCommitLive,
  GitHubContentsLive,
  GitHubPullsLive,
  GitHubCreatePullLive,
  GitHubPullLive,
  GitHubUpdatePullLive,
  GitHubMergePullLive,
  GitHubPullFilesLive,
);

/** What {@link Server} exposes: the composed HTTP handler for every plane. */
export interface ServerShape {
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError,
    Scope.Scope | HttpServerRequest.HttpServerRequest | RuntimeContext
  >;
}

const makeServer = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(api),
    // The engine's own routes, outside whatever middleware `api` carries.
    HttpApiBuilder.layer(InternalApi),
  ).pipe(
    Layer.provide([Http.handlers(api), Http.handlers(InternalApi)]),
    Layer.provide(Http.Platform),
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
    // The route effects' request-scoped needs are all served by the
    // Worker's request (a scope, the request, the runtime): the deferred
    // exclusions above cannot say so for a generic `api`.
    Effect.map((fetch): ServerShape => ({
      fetch: fetch as ServerShape["fetch"],
    })),
  );

/**
 * `Git.Server` — the top-level building block (RFC "Git Building
 * Blocks" §4): a `Context.Service` exposing the composed HTTP handler
 * for all three planes (git smart-HTTP wire, `/api/v1` REST, `/api/v3`
 * GitHub compat). The package ships no Worker — construct your own and
 * wire `fetch` in. `Server.layer(api)` serves an API derived from
 * {@link GitApi}: yours, with your middleware in front of every route
 * and your own routes beside them; {@link Handlers} implements the
 * engine's routes, and a Layer provided nearer than it overrides one.
 * {@link ServerLive} is the open default: `Git.Api`, `Handlers`, nothing
 * in front.
 *
 * ```ts
 * class AppApi extends Git.Api.middleware(Session) {}
 *
 * const GitLive = Git.Server.layer(AppApi).pipe(
 *   Layer.provide(Git.Handlers),
 *   Layer.provide(SessionLive),
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
export class Server extends Context.Service<Server, ServerShape>()(
  "alchemy/Git/Server",
) {
  /**
   * `Git.Server` over an API derived from {@link GitApi}. Requires an
   * implementation of every route ({@link Handlers} for the engine's,
   * yours for the rest), the API's middleware, and the storage blocks.
   */
  static readonly layer = <
    Id extends string,
    Groups extends HttpApiGroup.Constraint,
  >(
    api: HttpApi.HttpApi<Id, Groups>,
  ) => Layer.effect(Server, makeServer(api));
}

/**
 * The default `Git.Server` assembly: {@link GitApi} with {@link Handlers}
 * and nothing in front of the routes. Provide {@link ReposDurableObject}
 * and {@link RegistryDurableObject} (or your own implementations of the
 * underlying namespaces) in the same layer graph.
 *
 * @layer
 * @provides Git.Server
 */
export const ServerLive = Server.layer(GitApi).pipe(Layer.provide(Handlers));

/**
 * Hosts the `GitRegistry` Durable Object (owner/name → repoId) and
 * provides its namespace service.
 *
 * @layer
 */

/**
 * Hosts the `GitRepo` Durable Object (refs, objects, pulls, the wire
 * protocol) and provides {@link RepoStore} over its namespace. Requires a
 * {@link BlobStore} — provide `Git.BlobStoreR2(yourBucket)` in the same
 * layer graph; one provision serves this DO and the Worker-side reads —
 * plus the {@link Hasher} and the registry.
 *
 * @layer
 * @provides Git.RepoStore
 */
export const ReposDurableObject = Layer.effect(
  RepoStore,
  Effect.gen(function* () {
    const namespace = yield* GitRepo;
    return { getByName: (repoId) => namespace.getByName(repoId) };
  }),
).pipe(Layer.provideMerge(GitRepoLive));
