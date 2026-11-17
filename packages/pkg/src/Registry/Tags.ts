import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The `tags` table: one row per `(package, tag)` pointing at a tarball hash.
 * A tarball lives in R2 for as long as any row points at it. Every query
 * runs against the ambient `SqlClient`, which the Worker provides from its
 * D1 binding.
 */

const LinkedPrs = Schema.String.pipe(Schema.Array, Schema.fromJsonString);

export const TagRow = Schema.Struct({
  package: Schema.String,
  tag: Schema.String,
  sha256: Schema.String,
  expires_at: Schema.Number,
  /** Pull requests whose runs produced this tag, as `owner/repo#N`. */
  linked_prs: LinkedPrs,
  /** The kept branch this row is the latest publication of, if any. */
  head_of: Schema.NullOr(Schema.String),
});
export type TagRow = typeof TagRow.Type;

const TarballRow = Schema.Struct({
  package: Schema.String,
  sha256: Schema.String,
});

const decodeTags = Schema.decodeUnknownEffect(Schema.Array(TagRow));
const decodeTarballs = Schema.decodeUnknownEffect(Schema.Array(TarballRow));

export const get = Effect.fn("Tags.get")(function* (pkg: string, tag: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeTags(
    yield* sql`SELECT * FROM tags WHERE package = ${pkg} AND tag = ${tag}`,
  );
  return rows[0];
});

/**
 * Point `tag` at `sha256`, keeping the row alive for at least `expiresAt`
 * and remembering every pull request that produced it. `headOf` marks the
 * row as the latest publication of a kept branch; a publication without it
 * leaves an existing mark alone. One statement, so concurrent publications
 * of a shared tag merge rather than overwrite.
 */
export const upsert = Effect.fn("Tags.upsert")(function* (input: {
  readonly package: string;
  readonly tag: string;
  readonly sha256: string;
  readonly expiresAt: number;
  readonly prs: ReadonlyArray<string>;
  readonly headOf: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const prs = yield* Schema.encodeEffect(LinkedPrs)(input.prs);
  yield* sql`
    INSERT INTO tags (package, tag, sha256, expires_at, linked_prs, head_of)
    VALUES (${input.package}, ${input.tag}, ${input.sha256}, ${input.expiresAt}, ${prs}, ${input.headOf})
    ON CONFLICT (package, tag) DO UPDATE SET
      sha256 = excluded.sha256,
      expires_at = max(tags.expires_at, excluded.expires_at),
      head_of = coalesce(excluded.head_of, tags.head_of),
      linked_prs = (
        SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(tags.linked_prs)
          UNION
          SELECT value FROM json_each(excluded.linked_prs)
        )
      )
  `;
});

export const resolve = (pkg: string, tag: string) =>
  Effect.map(get(pkg, tag), (row) => row?.sha256);

/** Rows tied to pull requests whose expiry falls before `before`. */
export const dueLinked = Effect.fn("Tags.dueLinked")(function* (before: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeTags(
    yield* sql`
      SELECT * FROM tags WHERE linked_prs != '[]' AND expires_at < ${before}
    `,
  );
});

export const setExpiry = Effect.fn("Tags.setExpiry")(function* (
  pkg: string,
  tag: string,
  expiresAt: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE tags SET expires_at = ${expiresAt} WHERE package = ${pkg} AND tag = ${tag}
  `;
});

/**
 * Hand a kept branch's older rows of `pkg` back to the TTL once a newer
 * publication from the branch has written `current`. Each released row
 * lives until at least `expiresAt`.
 */
export const releaseHead = Effect.fn("Tags.releaseHead")(function* (input: {
  readonly package: string;
  readonly branch: string;
  readonly current: ReadonlyArray<string>;
  readonly expiresAt: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE tags SET head_of = NULL, expires_at = max(expires_at, ${input.expiresAt})
    WHERE package = ${input.package} AND head_of = ${input.branch}
      AND NOT ${sql.in("tag", input.current)}
  `;
});

/**
 * Delete every expired row and return the tarballs those rows pointed at.
 * The latest publication of a kept branch never expires.
 */
export const deleteExpired = Effect.fn("Tags.deleteExpired")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeTarballs(
    yield* sql`
      DELETE FROM tags WHERE expires_at < ${now} AND head_of IS NULL RETURNING package, sha256
    `,
  );
});

/** Every tarball some tag still points at, as `<package>/<sha256>`. */
export const referencedTarballs = Effect.fn("Tags.referencedTarballs")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* decodeTarballs(yield* sql`SELECT DISTINCT package, sha256 FROM tags`);
  return new Set(rows.map((row) => `${row.package}/${row.sha256}`));
});
