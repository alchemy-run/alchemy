/**
 * GitHub REST v3 compatibility facade (`/api/v3/**`) — DESIGN.md "Tier 1".
 *
 * Lets GitHub-flavored tooling talk to the service unmodified. The target
 * consumers are `gh api` (via `GH_HOST=<host>` + `GH_ENTERPRISE_TOKEN`,
 * which sends REST to `https://<host>/api/v3/...`) and Octokit-style SDKs
 * pointed at a GitHub Enterprise `baseUrl`. Only the REST plane is
 * mimicked — the `gh pr`/`gh issue` porcelain commands speak GraphQL and
 * are out of scope (use `gh api` paths instead).
 *
 * This module is a pure TRANSLATION layer: every route parses GitHub's
 * request shapes, calls the same Repo-DO RPCs the native `/api/v1` plane
 * uses (auth enforcement stays in the DO), and re-shapes responses into
 * GitHub's JSON. GitHub-isms handled here:
 *
 * - `Authorization: token <t>` (gh's scheme) — parsed by `Auth.ts`
 *   alongside Bearer/Basic.
 * - A merged PR is `state: "closed"` with `merged: true` (our tri-state
 *   `merged` collapses into GitHub's boolean).
 * - Errors are `{ message }` with GitHub's status conventions (401
 *   "Requires authentication", 404 "Not Found", 405 for unsupported merge
 *   methods, 409 for conflicts).
 * - List pagination is RFC-5988 `Link: <...>; rel="next"` headers. The
 *   next URL carries an opaque `cursor` (not a page number) — `gh api
 *   --paginate` and Octokit follow the URL verbatim, so keyset cursors
 *   work transparently.
 *
 * Deliberately absent (documented, not accidental): issues, reviews,
 * comments, checks, search, GraphQL, rename detection in file lists, and
 * additions/deletions line counts (reported as 0 — the server does not
 * compute content diffs; fetch blobs and diff client-side).
 */
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { parseBasicOrBearer } from "./Auth.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { RegistryEntry } from "./RegistryObject.ts";
import type {
  CallerAuth,
  CommitData,
  CommitDiffData,
  CompareData,
  CreatedTokenData,
  FileData,
  MergePullResult,
  PullData,
  PullDetailData,
  PullsPage,
  RefsPage,
  RepoMetaData,
  CommitLogPage,
  SignatureData,
} from "./RepoObject.ts";
import type { DiffEntryData } from "./git/TreeDiff.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies injected by the Worker
// ─────────────────────────────────────────────────────────────────────────────

/** Outcome of the Worker's shared owner/repo + credential prelude. */
export type CompatPrelude =
  | {
      readonly kind: "halt";
      readonly response: HttpServerResponse.HttpServerResponse;
    }
  | {
      readonly kind: "ok";
      readonly entry: RegistryEntry;
      readonly auth: CallerAuth;
    };

/** The slice of the Repo-DO stub the facade calls. */
export interface CompatRepoStub {
  readonly getRepoMeta: (
    auth: CallerAuth,
  ) => Effect.Effect<RepoMetaData, { readonly _tag: string }, RuntimeContext>;
  readonly listRefs: (
    auth: CallerAuth,
    prefix?: string | undefined,
  ) => Effect.Effect<RefsPage, { readonly _tag: string }, RuntimeContext>;
  readonly readCommitLog: (
    auth: CallerAuth,
    input: {
      readonly ref?: string | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<CommitLogPage, { readonly _tag: string }, RuntimeContext>;
  readonly readCommitDiff: (
    auth: CallerAuth,
    input: { readonly oid: string },
  ) => Effect.Effect<CommitDiffData, { readonly _tag: string }, RuntimeContext>;
  readonly compareCommits: (
    auth: CallerAuth,
    input: { readonly base: string; readonly head: string },
  ) => Effect.Effect<CompareData, { readonly _tag: string }, RuntimeContext>;
  readonly readFileAtPath: (
    auth: CallerAuth,
    input: { readonly ref?: string | undefined; readonly path: string },
  ) => Effect.Effect<FileData, { readonly _tag: string }, RuntimeContext>;
  readonly createPull: (
    auth: CallerAuth,
    input: {
      readonly title: string;
      readonly body?: string | undefined;
      readonly base: string;
      readonly head: string;
    },
  ) => Effect.Effect<PullData, { readonly _tag: string }, RuntimeContext>;
  readonly listPulls: (
    auth: CallerAuth,
    input: {
      readonly state?: "open" | "closed" | "merged" | "all" | undefined;
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<PullsPage, { readonly _tag: string }, RuntimeContext>;
  readonly getPull: (
    auth: CallerAuth,
    number: number,
  ) => Effect.Effect<PullDetailData, { readonly _tag: string }, RuntimeContext>;
  readonly updatePull: (
    auth: CallerAuth,
    input: {
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | null | undefined;
      readonly state?: "open" | "closed" | undefined;
    },
  ) => Effect.Effect<PullData, { readonly _tag: string }, RuntimeContext>;
  readonly mergePull: (
    auth: CallerAuth,
    input: {
      readonly number: number;
      readonly message?: string | undefined;
      readonly expectedHeadOid?: string | undefined;
    },
  ) => Effect.Effect<
    MergePullResult,
    { readonly _tag: string },
    RuntimeContext
  >;
  readonly createToken: (
    auth: CallerAuth,
    input: {
      readonly name: string;
      readonly scope: "read" | "write" | "admin";
      readonly ttlSeconds?: number | undefined;
    },
  ) => Effect.Effect<
    CreatedTokenData,
    { readonly _tag: string },
    RuntimeContext
  >;
}

export interface GithubCompatOptions {
  /**
   * The Worker's `rawRestPrelude`: resolves `owner/repo`, parses
   * credentials (anonymous allowed — public repos), and 404s/500s early.
   */
  readonly prelude: (
    owner: string,
    repo: string,
  ) => Effect.Effect<
    CompatPrelude,
    never,
    HttpServerRequest.HttpServerRequest | RuntimeContext
  >;
  /** Timing-safe admin-key check over the raw Authorization header. */
  readonly isAdmin: (
    headers: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<boolean, never, RuntimeContext>;
  /** Repo-DO stub by repoId (the Worker's `repos.getByName`). */
  readonly stub: (repoId: string) => CompatRepoStub;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const OID_RE = /^[0-9a-f]{40}$/;

const iso = (epochMs: number): string => new Date(epochMs).toISOString();

const isoSeconds = (sig: SignatureData): string =>
  new Date(sig.date * 1000).toISOString();

/** Stable 48-bit integer id from a string (GitHub ids are numbers). */
const intId = (value: string): number => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index++) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffn;
  }
  return Number(hash);
};

const shortRef = (ref: string): string => ref.replace(/^refs\/heads\//, "");

/** `https://host` of the incoming request (same derivation as remotes). */
const originOf = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const host = request.headers.host;
  const proto = request.headers["x-forwarded-proto"] ?? "https";
  return host === undefined ? "" : `${proto}://${host}`;
});

const ghJson = (
  value: unknown,
  options?: {
    readonly status?: number;
    readonly headers?: Record<string, string>;
  },
) =>
  HttpServerResponse.json(value, {
    status: options?.status ?? 200,
    headers: options?.headers,
  }).pipe(Effect.orDie);

const ghError = (status: number, message: string) =>
  ghJson({ message }, { status });

const ghNotFound = ghError(404, "Not Found");
const ghUnauthorized = ghError(401, "Requires authentication");

/**
 * Maps the DO's typed error union onto GitHub's status conventions. Every
 * facade route ends with this — unknown tags become 500s via `Effect.die`
 * (defects, not silent 200s).
 */
const ghCatch = <A, R>(
  effect: Effect.Effect<
    A,
    { readonly _tag: string; readonly message?: string },
    R
  >,
): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  effect.pipe(
    Effect.catchIf(
      (error): error is { _tag: string } => typeof error?._tag === "string",
      (error) => {
        switch (error._tag) {
          case "Unauthorized":
            return ghUnauthorized;
          case "Forbidden":
            return ghError(403, "Forbidden");
          case "RepoNotFound":
          case "RefNotFound":
          case "ObjectNotFound":
          case "PullNotFound":
          case "BranchMissing":
            return ghNotFound;
          case "WrongObjectType":
          case "ValidationError":
          case "NoMergeBase":
            return ghError(422, "Validation Failed");
          case "PullExists":
            return ghError(
              422,
              "Validation Failed: a pull request already exists for this head/base",
            );
          case "PullStateConflict":
          case "NothingToMerge":
            return ghError(405, "Pull Request is not mergeable");
          case "MergeConflict":
            return ghError(409, "Merge conflict");
          case "RefConflict":
            return ghError(
              409,
              "Head branch was modified. Review and try the merge again.",
            );
          case "ReadOnlyRepo":
            return ghError(403, "Repository is archived (read-only)");
          case "StoreError":
            return ghError(500, "Internal error");
          default:
            return Effect.die(error);
        }
      },
    ),
  );

// ─────────────────────────────────────────────────────────────────────────────
// Shape mappers (our data → GitHub JSON)
// ─────────────────────────────────────────────────────────────────────────────

const ghUser = (login: string) => ({
  login,
  id: intId(login),
  node_id: `U_${login}`,
  type: login === "admin" ? "User" : "Organization",
  site_admin: login === "admin",
});

const ghRepo = (meta: RepoMetaData, origin: string) => ({
  id: intId(meta.repoId),
  node_id: meta.repoId,
  name: meta.name,
  full_name: `${meta.owner}/${meta.name}`,
  owner: ghUser(meta.owner),
  private: !meta.public,
  visibility: meta.public ? "public" : "private",
  html_url: `${origin}/${meta.owner}/${meta.name}`,
  description: meta.description,
  fork: meta.forkOf !== null,
  url: `${origin}/api/v3/repos/${meta.owner}/${meta.name}`,
  clone_url: `${origin}/${meta.owner}/${meta.name}.git`,
  git_url: `${origin}/${meta.owner}/${meta.name}.git`,
  ssh_url: `${origin}/${meta.owner}/${meta.name}.git`,
  default_branch: meta.defaultBranch,
  created_at: iso(meta.createdAt),
  updated_at: iso(meta.createdAt),
  pushed_at: iso(meta.createdAt),
  archived: meta.readOnly,
  disabled: false,
  size: Math.ceil(meta.objects.bytes / 1024),
});

const ghCommit = (commit: CommitData, origin: string, repoUrl: string) => ({
  sha: commit.oid,
  node_id: commit.oid,
  url: `${repoUrl}/commits/${commit.oid}`,
  html_url: `${origin.replace("/api/v3", "")}`,
  commit: {
    message: commit.message,
    author: {
      name: commit.author.name,
      email: commit.author.email,
      date: isoSeconds(commit.author),
    },
    committer: {
      name: commit.committer.name,
      email: commit.committer.email,
      date: isoSeconds(commit.committer),
    },
    tree: { sha: commit.tree },
  },
  author: null,
  committer: null,
  parents: commit.parents.map((sha) => ({
    sha,
    url: `${repoUrl}/commits/${sha}`,
  })),
});

/**
 * One changed file, GitHub `pulls/:n/files` shape. `additions`/`deletions`
 * are 0 by design: the server never computes content diffs (DESIGN.md
 * §"content diffs are client-side").
 */
const ghFile = (entry: DiffEntryData) => ({
  sha: entry.newOid ?? entry.oldOid ?? "",
  filename: entry.path,
  status: entry.status,
  additions: 0,
  deletions: 0,
  changes: 0,
  previous_filename: undefined,
});

const ghPullState = (state: PullData["state"]): "open" | "closed" =>
  state === "open" ? "open" : "closed";

const ghPull = (
  pull: PullData & Partial<PullDetailData>,
  meta: RepoMetaData,
  origin: string,
) => {
  const repoUrl = `${origin}/api/v3/repos/${meta.owner}/${meta.name}`;
  return {
    id: intId(`${meta.repoId}#${pull.number}`),
    node_id: `PR_${meta.repoId}_${pull.number}`,
    number: pull.number,
    state: ghPullState(pull.state),
    merged: pull.state === "merged",
    locked: false,
    draft: false,
    title: pull.title,
    body: pull.body,
    user: ghUser(meta.owner),
    html_url: `${origin}/${meta.owner}/${meta.name}/pulls/${pull.number}`,
    url: `${repoUrl}/pulls/${pull.number}`,
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.state === "open" ? null : iso(pull.updatedAt),
    merged_at: pull.mergedAt === null ? null : iso(pull.mergedAt ?? 0),
    merge_commit_sha: pull.mergeCommit,
    base: {
      ref: shortRef(pull.baseRef),
      label: `${meta.owner}:${shortRef(pull.baseRef)}`,
      sha: pull.baseOid ?? "",
      repo: { full_name: `${meta.owner}/${meta.name}` },
    },
    head: {
      ref: shortRef(pull.headRef),
      label: `${meta.owner}:${shortRef(pull.headRef)}`,
      sha: pull.headOid ?? "",
      repo: { full_name: `${meta.owner}/${meta.name}` },
    },
    mergeable: pull.mergeable ?? null,
    mergeable_state:
      pull.mergeableReason === "conflict"
        ? "dirty"
        : pull.mergeable === true
          ? "clean"
          : "unknown",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the `/api/v3` route layer. Mounted by the GitWorker next to the
 * git wire routes; every repo-scoped route flows through the same
 * `prelude` (resolution + credential parsing + anonymous-public policy)
 * as the raw REST routes.
 */
export const githubCompatRoutes = (options: GithubCompatOptions) => {
  const { prelude, isAdmin, stub } = options;

  /** Repo-scoped route body: prelude, then handler with entry+auth. */
  const withRepo = <R>(
    handler: (context: {
      readonly entry: RegistryEntry;
      readonly auth: CallerAuth;
      readonly repo: CompatRepoStub;
      readonly origin: string;
      readonly repoUrl: string;
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly url: URL;
      readonly params: Readonly<Record<string, string | undefined>>;
    }) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      { readonly _tag: string },
      R
    >,
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const owner = (params.owner ?? "").toLowerCase();
      const name = (params.repo ?? "").toLowerCase();
      const resolved = yield* prelude(owner, name);
      if (resolved.kind === "halt") {
        // The prelude's plain-text halts become GitHub JSON errors.
        const status = resolved.response.status;
        return yield* status === 401
          ? ghUnauthorized
          : status === 404
            ? ghNotFound
            : ghError(status, "Internal error");
      }
      const origin = yield* originOf;
      const result = yield* ghCatch(
        handler({
          entry: resolved.entry,
          auth: resolved.auth,
          repo: stub(resolved.entry.repoId),
          origin,
          repoUrl: `${origin}/api/v3/repos/${owner}/${name}`,
          request,
          url: new URL(request.url, "http://internal"),
          params,
        }),
      );
      return result as HttpServerResponse.HttpServerResponse;
    });

  /** `Link: <…>; rel="next"` for cursor pages, GitHub-style. */
  const linkHeaders = (
    base: string,
    query: URLSearchParams,
    nextCursor: string | null,
  ): Record<string, string> => {
    if (nextCursor === null) return {};
    const next = new URLSearchParams(query);
    next.set("cursor", nextCursor);
    return { link: `<${base}?${next}>; rel="next"` };
  };

  const perPage = (url: URL): number => {
    const raw = Number.parseInt(url.searchParams.get("per_page") ?? "30", 10);
    return Number.isFinite(raw) ? Math.max(1, Math.min(raw, 100)) : 30;
  };

  /** Resolves `:sha` path segments that may be refs (GitHub allows both). */
  const resolveSha = (
    repo: CompatRepoStub,
    auth: CallerAuth,
    revision: string,
  ) =>
    OID_RE.test(revision)
      ? Effect.succeed(revision)
      : repo
          .readCommitLog(auth, { ref: revision, limit: 1 })
          .pipe(Effect.map((page) => page.items[0]?.oid ?? revision));

  return Layer.mergeAll(
    // ── the auth probe ──────────────────────────────────────────────────
    // `gh` hits `/user` to validate its token. Repo tokens are per-repo,
    // so the only globally verifiable identity is the admin key; other
    // syntactically valid tokens get a generic identity and are enforced
    // per-repo by the DO on every real operation.
    HttpRouter.add(
      "GET",
      "/api/v3/user",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const credentials = parseBasicOrBearer(request.headers);
        if (credentials === undefined) return yield* ghUnauthorized;
        const admin = yield* isAdmin(request.headers);
        return yield* ghJson(ghUser(admin ? "admin" : "token"));
      }),
    ),

    // ── repos ───────────────────────────────────────────────────────────
    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo",
      withRepo(({ repo, auth, origin }) =>
        repo
          .getRepoMeta(auth)
          .pipe(Effect.flatMap((meta) => ghJson(ghRepo(meta, origin)))),
      ),
    ),

    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/branches",
      withRepo(({ repo, auth }) =>
        repo.listRefs(auth, "refs/heads/").pipe(
          Effect.flatMap((page) =>
            ghJson(
              page.refs.map((ref) => ({
                name: shortRef(ref.name),
                commit: { sha: ref.oid },
                protected: false,
              })),
            ),
          ),
        ),
      ),
    ),

    // ── commits ─────────────────────────────────────────────────────────
    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/commits",
      withRepo(({ repo, auth, origin, repoUrl, url }) =>
        repo
          .readCommitLog(auth, {
            ref: url.searchParams.get("sha") ?? undefined,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: perPage(url),
          })
          .pipe(
            Effect.flatMap((page) =>
              ghJson(
                page.items.map((commit) => ghCommit(commit, origin, repoUrl)),
                {
                  headers: linkHeaders(
                    `${repoUrl}/commits`,
                    url.searchParams,
                    page.hasMore ? page.nextCursor : null,
                  ),
                },
              ),
            ),
          ),
      ),
    ),

    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/commits/:sha",
      withRepo(({ repo, auth, origin, repoUrl, params }) =>
        Effect.gen(function* () {
          const oid = yield* resolveSha(repo, auth, params.sha ?? "");
          const log = yield* repo.readCommitLog(auth, { ref: oid, limit: 1 });
          const commit = log.items[0];
          if (commit === undefined) return yield* ghNotFound;
          const diff = yield* repo.readCommitDiff(auth, { oid });
          return yield* ghJson({
            ...ghCommit(commit, origin, repoUrl),
            files: diff.files.map(ghFile),
          });
        }),
      ),
    ),

    // ── contents ────────────────────────────────────────────────────────
    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/contents/*",
      withRepo(({ repo, auth, url, repoUrl }) =>
        Effect.gen(function* () {
          const marker = "/contents/";
          const at = url.pathname.indexOf(marker);
          const path = decodeURIComponent(
            url.pathname.slice(at + marker.length),
          );
          if (path.length === 0) return yield* ghNotFound;
          const ref = url.searchParams.get("ref") ?? undefined;
          const file = yield* repo.readFileAtPath(auth, { ref, path });
          return yield* ghJson({
            type: "file",
            encoding: "base64",
            size: file.size,
            name: path.split("/").pop(),
            path,
            sha: file.oid,
            url: `${repoUrl}/contents/${path}`,
            content: Encoding.encodeBase64(file.content),
          });
        }),
      ),
    ),

    // ── pulls ───────────────────────────────────────────────────────────
    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/pulls",
      withRepo(({ repo, auth, entry, origin, repoUrl, url }) =>
        Effect.gen(function* () {
          // GitHub's `closed` includes merged; our store distinguishes.
          const requested = url.searchParams.get("state") ?? "open";
          const state =
            requested === "open"
              ? ("open" as const)
              : requested === "all"
                ? ("all" as const)
                : ("all" as const);
          const page = yield* repo.listPulls(auth, {
            state,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: perPage(url),
          });
          const meta = yield* repo.getRepoMeta(auth);
          const items = page.items.filter((pull) =>
            requested === "all"
              ? true
              : requested === "open"
                ? pull.state === "open"
                : pull.state !== "open",
          );
          return yield* ghJson(
            items.map((pull) => ghPull(pull, meta, origin)),
            {
              headers: linkHeaders(
                `${repoUrl}/pulls`,
                url.searchParams,
                page.hasMore ? page.nextCursor : null,
              ),
            },
          );
        }),
      ),
    ),

    HttpRouter.add(
      "POST",
      "/api/v3/repos/:owner/:repo/pulls",
      withRepo(({ repo, auth, origin, request }) =>
        Effect.gen(function* () {
          const body = (yield* request.json.pipe(
            Effect.mapError(() => ({ _tag: "ValidationError" as const })),
          )) as {
            title?: string;
            head?: string;
            base?: string;
            body?: string;
          };
          if (!body.title || !body.head || !body.base) {
            return yield* ghError(
              422,
              "Validation Failed: title, head and base are required",
            );
          }
          const pull = yield* repo.createPull(auth, {
            title: body.title,
            body: body.body,
            base: body.base,
            head: body.head,
          });
          const meta = yield* repo.getRepoMeta(auth);
          return yield* ghJson(ghPull(pull, meta, origin), { status: 201 });
        }),
      ),
    ),

    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/pulls/:number",
      withRepo(({ repo, auth, origin, params }) =>
        Effect.gen(function* () {
          const number = Number.parseInt(params.number ?? "", 10);
          if (!Number.isFinite(number)) return yield* ghNotFound;
          const pull = yield* repo.getPull(auth, number);
          const meta = yield* repo.getRepoMeta(auth);
          return yield* ghJson(ghPull(pull, meta, origin));
        }),
      ),
    ),

    HttpRouter.add(
      "PATCH",
      "/api/v3/repos/:owner/:repo/pulls/:number",
      withRepo(({ repo, auth, origin, params, request }) =>
        Effect.gen(function* () {
          const number = Number.parseInt(params.number ?? "", 10);
          if (!Number.isFinite(number)) return yield* ghNotFound;
          const body = (yield* request.json.pipe(
            Effect.mapError(() => ({ _tag: "ValidationError" as const })),
          )) as { title?: string; body?: string | null; state?: string };
          if (
            body.state !== undefined &&
            body.state !== "open" &&
            body.state !== "closed"
          ) {
            return yield* ghError(422, "Validation Failed: invalid state");
          }
          const pull = yield* repo.updatePull(auth, {
            number,
            title: body.title,
            body: body.body,
            state: body.state as "open" | "closed" | undefined,
          });
          const meta = yield* repo.getRepoMeta(auth);
          return yield* ghJson(ghPull(pull, meta, origin));
        }),
      ),
    ),

    HttpRouter.add(
      "PUT",
      "/api/v3/repos/:owner/:repo/pulls/:number/merge",
      withRepo(({ repo, auth, params, request }) =>
        Effect.gen(function* () {
          const number = Number.parseInt(params.number ?? "", 10);
          if (!Number.isFinite(number)) return yield* ghNotFound;
          const raw = yield* request.json.pipe(
            Effect.catch(() => Effect.succeed({})),
          );
          const body = raw as {
            commit_message?: string;
            sha?: string;
            merge_method?: string;
          };
          if (
            body.merge_method !== undefined &&
            body.merge_method !== "merge"
          ) {
            // squash/rebase rewrite history server-side — not supported.
            return yield* ghError(
              405,
              `Merge method '${body.merge_method}' is not supported`,
            );
          }
          const result = yield* repo.mergePull(auth, {
            number,
            message: body.commit_message,
            expectedHeadOid: body.sha,
          });
          return yield* ghJson({
            sha: result.oid,
            merged: true,
            message: "Pull Request successfully merged",
          });
        }),
      ),
    ),

    HttpRouter.add(
      "GET",
      "/api/v3/repos/:owner/:repo/pulls/:number/files",
      withRepo(({ repo, auth, params }) =>
        Effect.gen(function* () {
          const number = Number.parseInt(params.number ?? "", 10);
          if (!Number.isFinite(number)) return yield* ghNotFound;
          const pull = yield* repo.getPull(auth, number);
          // Open PR with live branches: three-dot compare. Merged PR: the
          // merge commit's first-parent diff is the canonical record.
          if (pull.baseOid !== null && pull.headOid !== null) {
            const compare = yield* repo.compareCommits(auth, {
              base: pull.baseRef,
              head: pull.headRef,
            });
            return yield* ghJson(compare.files.map(ghFile));
          }
          if (pull.mergeCommit !== null) {
            const diff = yield* repo.readCommitDiff(auth, {
              oid: pull.mergeCommit,
            });
            return yield* ghJson(diff.files.map(ghFile));
          }
          return yield* ghJson([]);
        }),
      ),
    ),
  );
};
