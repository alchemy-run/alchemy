/**
 * The `objects` group: commit, log, tree, blob, diff, and compare reads,
 * plus the two raw streaming reads (DESIGN.md §5): a blob's bytes as an
 * octet-stream, and a file at a path under a ref. The raw routes declare
 * no success schema and answer with the response they build.
 */
import * as Http from "../../Http/index.ts";
import * as Schema from "effect/Schema";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Authenticated } from "../Auth.ts";
import {
  Unauthorized,
  CommitDiff,
  CommitInfo,
  Comparison,
  NoMergeBase,
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
export class GetCommit extends Http.get<GetCommit>()(
  "commit",
  "/repos/:owner/:repo/commits/:oid",
  {
    params: RepoOidPath,
    success: CommitInfo,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/** Pages the commit history from a ref or oid. */
export class GetLog extends Http.get<GetLog>()(
  "log",
  "/repos/:owner/:repo/log",
  {
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
    error: [RepoNotFound, RefNotFound, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/** Reads one tree's entries. */
export class GetTree extends Http.get<GetTree>()(
  "tree",
  "/repos/:owner/:repo/trees/:oid",
  {
    params: RepoOidPath,
    success: Schema.Struct({
      oid: Oid,
      entries: Schema.Array(TreeEntry),
    }),
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/** Reads a small blob as base64 JSON (≤ 1 MiB; 422 otherwise — use /raw). */
export class GetBlob extends Http.get<GetBlob>()(
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
    error: [
      RepoNotFound,
      ObjectNotFound,
      WrongObjectType,
      ObjectTooLarge,
      Unauthorized,
    ],
    middleware: [Authenticated],
  },
) {}

/**
 * The changed-file list of a commit vs its FIRST parent (empty tree for a
 * root commit). Merge commits are diffed against parent[0] only — the
 * GitHub default. No rename detection in v1: a rename appears as
 * `removed` + `added`; clients may pair entries whose old/new oids match
 * for a cheap exact-rename display.
 */
export class GetDiff extends Http.get<GetDiff>()(
  "diff",
  "/repos/:owner/:repo/commits/:oid/diff",
  {
    params: RepoOidPath,
    success: CommitDiff,
    error: [RepoNotFound, ObjectNotFound, WrongObjectType, Unauthorized],
    middleware: [Authenticated],
  },
) {}

/**
 * Three-dot comparison: merge base, ahead/behind counts, head-side
 * commits, and the file diff of mergeBase..head. `base`/`head` accept a
 * refname (short or full) or a 40-hex oid; annotated tags are peeled.
 */
export class Compare extends Http.get<Compare>()(
  "compare",
  "/repos/:owner/:repo/compare",
  {
    params: RepoPath,
    query: Schema.Struct({
      /** Refname or oid of the base side. */
      base: Schema.String,
      /** Refname or oid of the head side. */
      head: Schema.String,
    }),
    success: Comparison,
    error: [
      RepoNotFound,
      RefNotFound,
      ObjectNotFound,
      WrongObjectType,
      NoMergeBase,
      Unauthorized,
    ],
    middleware: [Authenticated],
  },
) {}

/**
 * A blob's bytes as an octet-stream, no size cap (the per-object 64 MiB
 * ingest cap is the outer bound). Streams the response it builds.
 */
export class GetBlobRaw extends Http.get<GetBlobRaw>()(
  "blobRaw",
  "/repos/:owner/:repo/blobs/:oid/raw",
  { middleware: [Authenticated] },
) {}

/**
 * A file at `?path=` under `?ref=` (refname or oid; the default branch
 * when absent), walked tree by tree, as an octet-stream.
 */
export class GetFile extends Http.get<GetFile>()(
  "file",
  "/repos/:owner/:repo/file",
  { middleware: [Authenticated] },
) {}

/** The `objects` group, mounted at `/api/v1`. */
export class Objects extends HttpApiGroup.make("objects")
  .add(
    GetCommit,
    GetLog,
    GetTree,
    GetBlob,
    GetDiff,
    Compare,
    GetBlobRaw,
    GetFile,
  )
  .prefix("/api/v1") {}
