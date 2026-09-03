/**
 * The `refs` group: ref reads and transactional (CAS) writes (DESIGN.md §5).
 *
 * Ref names contain `/`, so the single-ref endpoints address the ref via
 * the `name` query parameter, not a path segment.
 */
import * as Schema from "effect/Schema";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  Unauthorized,
  Forbidden,
  ObjectNotFound,
  Oid,
  ReadOnlyRepo,
  Ref,
  RefConflict,
  RefName,
  RefNotFound,
  RepoNotFound,
  RepoPath,
} from "./Schema.ts";

/** Lists refs, optionally filtered by prefix (e.g. `refs/heads/`). */
export const list = HttpApiEndpoint.get("list", "/repos/:owner/:repo/refs", {
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
  error: [RepoNotFound, Unauthorized],
});

/** Reads one ref by full name (`?name=refs/heads/main`). */
export const get = HttpApiEndpoint.get("get", "/repos/:owner/:repo/ref", {
  params: RepoPath,
  query: Schema.Struct({ name: RefName }),
  success: Ref,
  error: [RepoNotFound, RefNotFound, Unauthorized],
});

/** Writes one ref with CAS semantics. */
export const update = HttpApiEndpoint.put("update", "/repos/:owner/:repo/ref", {
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
    Unauthorized,
  ],
});

/** Deletes one ref with CAS semantics. */
export const remove = HttpApiEndpoint.delete(
  "remove",
  "/repos/:owner/:repo/ref",
  {
    params: RepoPath,
    query: Schema.Struct({ name: RefName }),
    payload: Schema.Struct({
      /** CAS token: current oid the ref must hold. Absent = unconditional. */
      expectedOid: Schema.optional(Oid),
    }),
    success: HttpApiSchema.NoContent,
    error: [
      RepoNotFound,
      RefNotFound,
      RefConflict,
      ReadOnlyRepo,
      Forbidden,
      Unauthorized,
    ],
  },
);

/** The assembled `refs` group. */
export default HttpApiGroup.make("refs")
  .add(list)
  .add(get)
  .add(update)
  .add(remove);
