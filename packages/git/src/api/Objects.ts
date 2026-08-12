/**
 * The `objects` group: commit, log, tree, and small-blob reads
 * (DESIGN.md §5).
 *
 * Raw streaming reads are registered as RAW `HttpRouter` routes
 * (octet-stream), outside HttpApi schema-land by design (same policy as
 * the git wire endpoints):
 *
 * - `GET /api/v1/repos/:owner/:repo/blobs/:oid/raw`
 * - `GET /api/v1/repos/:owner/:repo/file?ref=<refname|oid>&path=<path>`
 *   (tree-walk per segment)
 */
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import {
  CommitInfo,
  GitAuth,
  ObjectNotFound,
  ObjectTooLarge,
  Oid,
  Paginated,
  RefNotFound,
  RepoNotFound,
  RepoOidPath,
  RepoPath,
  TreeEntry,
  WrongObjectType,
} from "./Schema.ts";

/** Reads one commit. */
export const commit = HttpApiEndpoint.get(
  "commit",
  "/repos/:owner/:repo/commits/:oid",
  {
    params: RepoOidPath,
    success: CommitInfo,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  },
);

/** Pages the commit history from a ref or oid. */
export const log = HttpApiEndpoint.get("log", "/repos/:owner/:repo/log", {
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
});

/** Reads one tree's entries. */
export const tree = HttpApiEndpoint.get(
  "tree",
  "/repos/:owner/:repo/trees/:oid",
  {
    params: RepoOidPath,
    success: Schema.Struct({
      oid: Oid,
      entries: Schema.Array(TreeEntry),
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType],
  },
);

/** Reads a small blob as base64 JSON (≤ 1 MiB; 422 otherwise — use /raw). */
export const blob = HttpApiEndpoint.get(
  "blob",
  "/repos/:owner/:repo/blobs/:oid",
  {
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
  },
);

/** The assembled `objects` group. */
export const Group = HttpApiGroup.make("objects")
  .add(commit)
  .add(log)
  .add(tree)
  .add(blob)
  .middleware(GitAuth);
