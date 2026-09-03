/**
 * The `repos` group: repo CRUD, fork, import, and compaction
 * (DESIGN.md §5). Every route is an `alchemy/Http` route class behind the
 * {@link Authenticated} middleware; the policy decides what the caller may
 * do (registry-level actions here at the Worker, per-repo actions in the
 * Repo DO).
 */
import * as Http from "../../Http/index.ts";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import { Authenticated } from "../Auth.ts";
import {
  Unauthorized,
  Forbidden,
  ImportFailed,
  OwnerName,
  Paginated,
  RefNotFound,
  Repo,
  RepoAlreadyExists,
  RepoCreated,
  RepoName,
  RepoNotFound,
  RepoNotReady,
  RepoPath,
  ValidationError,
} from "./Schema.ts";

/** Creates a repo owned by `owner`; the caller must be allowed `CreateRepo` there. */
export class CreateRepo extends Http.post<CreateRepo>()("create", "/repos", {
  payload: Schema.Struct({
    owner: OwnerName,
    name: RepoName,
    /** Default branch short name. @default "main" */
    defaultBranch: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    /**
     * Anyone can read/clone without a credential when `true`.
     * @default false
     */
    public: Schema.optional(Schema.Boolean),
    /** @default false */
    readOnly: Schema.optional(Schema.Boolean),
  }),
  success: RepoCreated,
  error: [RepoAlreadyExists, ValidationError, Forbidden, Unauthorized],
  middleware: [Authenticated],
}) {}

/** Reads one repo (poll `status` for async fork/import/delete progress). */
export class GetRepo extends Http.get<GetRepo>()("get", "/repos/:owner/:repo", {
  params: RepoPath,
  success: Repo,
  error: [RepoNotFound, Unauthorized],
  middleware: [Authenticated],
}) {}

/** Patches description / default branch / readOnly / public. */
export class UpdateRepo extends Http.patch<UpdateRepo>()(
  "update",
  "/repos/:owner/:repo",
  {
    params: RepoPath,
    payload: Schema.Struct({
      description: Schema.optional(Schema.NullOr(Schema.String)),
      /** Must resolve to an existing branch. */
      defaultBranch: Schema.optional(Schema.String),
      readOnly: Schema.optional(Schema.Boolean),
      /** Anyone can read/clone without a credential when `true`. */
      public: Schema.optional(Schema.Boolean),
    }),
    success: Repo,
    error: [RepoNotFound, RefNotFound, Forbidden, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/** Lists repos, optionally filtered by owner. Private repos need `ListRepos`. */
export class ListRepos extends Http.get<ListRepos>()("list", "/repos", {
  query: Schema.Struct({
    owner: Schema.optional(OwnerName),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    ),
  }),
  success: Paginated(Repo),
  error: Unauthorized,
  middleware: [Authenticated],
}) {}

/**
 * Deletes a repo. Async purge: responds 204 immediately, repo `status`
 * flips to `'deleting'`, the name frees after the purge alarm completes
 * (then 404).
 */
export class DeleteRepo extends Http.del<DeleteRepo>()(
  "delete",
  "/repos/:owner/:repo",
  {
    params: RepoPath,
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, Forbidden, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/**
 * Forks a repo. The fork starts in `status: 'forking'`; poll
 * `GET /repos/:owner/:repo` until `'ready'`.
 */
export class ForkRepo extends Http.post<ForkRepo>()(
  "fork",
  "/repos/:owner/:repo/fork",
  {
    params: RepoPath,
    payload: Schema.Struct({
      targetOwner: OwnerName,
      targetName: RepoName,
    }),
    success: RepoCreated,
    error: [
      RepoNotFound,
      RepoAlreadyExists,
      RepoNotReady,
      Forbidden,
      Unauthorized,
    ],
    middleware: [Authenticated],
  },
) {}

/**
 * Imports from an external smart-HTTP source. The repo starts in
 * `status: 'importing'`; poll `GET /repos/:owner/:repo` until `'ready'`.
 */
export class ImportRepo extends Http.post<ImportRepo>()(
  "import",
  "/repos/import",
  {
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
    success: RepoCreated,
    error: [RepoAlreadyExists, ImportFailed, Forbidden, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/**
 * Forces a compaction run now (`Maintain`): moves loose object bytes into
 * an immutable pack. Normally armed automatically by size thresholds after
 * a push — this is the operator/benchmark handle. Returns immediately; poll
 * `GET /repos/:owner/:repo` and watch `objects.loose` fall to zero.
 */
export class CompactRepo extends Http.post<CompactRepo>()(
  "compact",
  "/repos/:owner/:repo/compact",
  {
    params: RepoPath,
    success: HttpApiSchema.NoContent,
    error: [RepoNotFound, Forbidden, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/** The `repos` group, mounted at `/api/v1`. */
export class Repos extends HttpApiGroup.make("repos")
  .add(
    CreateRepo,
    GetRepo,
    UpdateRepo,
    ListRepos,
    DeleteRepo,
    ForkRepo,
    ImportRepo,
    CompactRepo,
  )
  .prefix("/api/v1") {}
