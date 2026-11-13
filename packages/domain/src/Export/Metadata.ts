/**
 * Metadata: columns a store records beside each row of a table, computed
 * the same way by every store. Every table has `_export_ingested_at` (when
 * the row reached its store) and `_export_lag_ms` (milliseconds from the
 * event's commit to then). A table declares more as Schema fields, each
 * built here so it says how it is computed; the read row carries them as
 * top-level fields, so `where` and `orderBy` reach them as they reach the
 * row's own.
 *
 * ### Adding metadata
 * **Example:** The tenant of each row, copied from its event
 * ```typescript
 * export class Facts extends Export.Table("Facts", { ... }, {
 *   table: "facts",
 *   version: 2,
 *   metadata: { _export_tenant: Export.Metadata.copy("event.tenant", Schema.String) },
 * }) {}
 * ```
 *
 * ### Changing metadata <!-- api-prose -->
 * Metadata is part of a table's spec: adding, removing or changing a column
 * needs a new `version`. The table is rebuilt from history into the new
 * generation, and the rebuild keeps what the original writes recorded: a
 * run value (`_export_ingested_at`) is carried from the generation being
 * replaced, matched by identity, and every other column is computed again
 * from the row and the carried values. So `_export_lag_ms` stays the lag the
 * row had when it was first written.
 *
 * @module
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { jsonAt } from "../internal.ts";
import type { MetadataColumn, MetadataValue } from "./Spec.ts";

/** A metadata field's name. The prefix keeps it apart from the row's own fields. */
export type Name = `_export_${string}`;

/** A Schema a metadata column can hold: one that needs no services to encode or decode. */
export type Storable = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

/**
 * Metadata fields a table declares beside the ones every table has: each
 * named `_export_*`, each a Schema needing no services. Mapped over the
 * declared keys (not an index signature), so a table generic over its
 * metadata still knows every column decodes without services.
 */
export type Fields<M> = { readonly [K in keyof M]: K extends Name ? Storable : never };

const computed = <S extends Storable>(schema: S, value: MetadataValue) =>
  schema.annotate({ exportMetadata: value });

/** Whole milliseconds from one timestamp to another; each a row path (`envelope.at`) or a metadata column. */
export const elapsed = (from: string, to: string) =>
  computed(Schema.Int, { _tag: "Elapsed", from, to });

/** A copy of one row value, by path (`event.tenant`), held as `schema`. */
export const copy = <S extends Storable>(path: string, schema: S) =>
  computed(schema, { _tag: "Copy", path });

/** When the row reached its store: one time per run, carried by a rebuild. */
export const ingestedAt = computed(Schema.DateTimeUtc, { _tag: "Run", field: "ingestedAt" });

/** Milliseconds from the event's commit to the row reaching its store. */
export const lag = elapsed("envelope.at", "_export_ingested_at");

/** The metadata every table has. */
export const builtIn = { _export_ingested_at: ingestedAt, _export_lag_ms: lag };

/** The lag column's name, for stores that summarize it. */
export const lagColumn = "_export_lag_ms";

// ---------------------------------------------------------------- evaluation

/** The values of one run, the same for all its rows. */
export interface Run {
  readonly ingestedAt: DateTime.Utc;
}

const millisOf = (value: Schema.Json | undefined): number | undefined =>
  typeof value === "string"
    ? Option.getOrUndefined(Option.map(DateTime.make(value), DateTime.toEpochMillis))
    : undefined;

/**
 * One row's metadata, as JSON: what every store must record. `Run` values
 * come from `previous` (the row as the generation a rebuild replaces holds
 * it) when it has them, else from the run; the rest are computed in order,
 * reading the row and the metadata computed before them. A value that cannot
 * be computed (a missing path, a timestamp that does not parse) is `null`.
 */
export const evaluate = (
  metadata: ReadonlyArray<MetadataColumn>,
  row: Schema.JsonObject,
  run: Run,
  previous: Schema.JsonObject | undefined,
): Schema.JsonObject => {
  const values: Record<string, Schema.Json> = {};
  const read = (path: string) => (path in values ? values[path] : jsonAt(row, path));
  for (const { path, value } of metadata) {
    switch (value._tag) {
      case "Run":
        values[path] = previous?.[path] ?? DateTime.formatIso(run.ingestedAt);
        break;
      case "Elapsed": {
        const from = millisOf(read(value.from));
        const to = millisOf(read(value.to));
        values[path] = from === undefined || to === undefined ? null : Math.round(to - from);
        break;
      }
      case "Copy":
        values[path] = jsonAt(row, value.path) ?? null;
        break;
    }
  }
  return values;
};
