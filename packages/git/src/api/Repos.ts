/**
 * The `repos` group: repo CRUD + fork + import (DESIGN.md §5).
 *
 * Create/list-all/fork/import are admin-key-only; get/update/delete accept
 * a suitably scoped repo token (enforced in the Repo DO).
 *
 * Each operation is exported under its wire operation name; the reserved
 * words are aliased (`export { del as delete, importRepo as import }`).
 */
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  Forbidden,
  GitAuth,
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

/** Creates a repo; the response carries a bootstrap `write` token. */
export const create = HttpApiEndpoint.post("create", "/repos", {
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
});

/** Reads one repo (poll `status` for async fork/import/delete progress). */
export const get = HttpApiEndpoint.get("get", "/repos/:owner/:repo", {
  params: RepoPath,
  success: Repo,
  error: RepoNotFound,
});

/** Patches description / default branch / readOnly. */
export const update = HttpApiEndpoint.patch("update", "/repos/:owner/:repo", {
  params: RepoPath,
  payload: Schema.Struct({
    description: Schema.optional(Schema.NullOr(Schema.String)),
    /** Must resolve to an existing branch. */
    defaultBranch: Schema.optional(Schema.String),
    readOnly: Schema.optional(Schema.Boolean),
  }),
  success: Repo,
  error: [RepoNotFound, RefNotFound, Forbidden],
});

/** Lists repos (admin-key-only), optionally filtered by owner. */
export const list = HttpApiEndpoint.get("list", "/repos", {
  query: Schema.Struct({
    owner: Schema.optional(OwnerName),
    cursor: Schema.optional(Schema.String),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
    ),
  }),
  success: Paginated(Repo),
});

/**
 * Deletes a repo. Async purge: responds 204 immediately, repo `status`
 * flips to `'deleting'`, the name frees after the purge alarm completes
 * (then 404).
 */
const del = HttpApiEndpoint.delete("delete", "/repos/:owner/:repo", {
  params: RepoPath,
  success: HttpApiSchema.NoContent,
  error: [RepoNotFound, Forbidden],
});
export { del as delete };

/**
 * Forks a repo. The fork starts in `status: 'forking'`; poll
 * `GET /repos/:owner/:repo` until `'ready'`.
 */
export const fork = HttpApiEndpoint.post("fork", "/repos/:owner/:repo/fork", {
  params: RepoPath,
  payload: Schema.Struct({
    targetOwner: OwnerName,
    targetName: RepoName,
  }),
  success: RepoCreated,
  error: [RepoNotFound, RepoAlreadyExists, RepoNotReady, Forbidden],
});

/**
 * Imports from an external smart-HTTP source. The repo starts in
 * `status: 'importing'`; poll `GET /repos/:owner/:repo` until `'ready'`.
 */
const importRepo = HttpApiEndpoint.post("import", "/repos/import", {
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
  error: [RepoAlreadyExists, ImportFailed, Forbidden],
});
export { importRepo as import };

/** The assembled `repos` group. */
export const Group = HttpApiGroup.make("repos")
  .add(create)
  .add(get)
  .add(update)
  .add(list)
  .add(del)
  .add(fork)
  .add(importRepo)
  .middleware(GitAuth);
