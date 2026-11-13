import * as galaxy from "@distilled.cloud/starburst-galaxy";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";

export interface TagAssignmentProps {
  /** ID of the tag to apply (a `Tag`'s `tagId`). Changing it replaces the assignment. */
  readonly tag: string;
  /** ID of the catalog the tagged object is in. Changing it replaces the assignment. */
  readonly catalog: string;
  /**
   * Schema to tag, instead of the whole catalog. Changing it replaces the assignment.
   */
  readonly schema?: string;
  /**
   * Table to tag, in `schema`. Requires `schema`. Changing it replaces the assignment.
   */
  readonly table?: string;
  /**
   * Column to tag, in `table`. Requires `table`. Changing it replaces the assignment.
   */
  readonly column?: string;
}

export interface TagAssignmentAttributes {
  /** ID of the applied tag. */
  readonly tagId: string;
  /** Name of the applied tag. */
  readonly tagName: string;
  /** ID of the catalog. */
  readonly catalogId: string;
  /** Tagged schema, for schema, table and column assignments. */
  readonly schemaId: string | undefined;
  /** Tagged table, for table and column assignments. */
  readonly tableId: string | undefined;
  /** Tagged column, for column assignments. */
  readonly columnId: string | undefined;
}

export type TagAssignment = Resource<
  "StarburstGalaxy.Governance.TagAssignment",
  TagAssignmentProps,
  TagAssignmentAttributes,
  never,
  Providers
>;

/**
 * One Starburst Galaxy tag applied to one catalog, schema, table or
 * column. The most specific of `schema`, `table` and `column` that is set
 * picks the level. Assignments made in Galaxy or by other stacks are never
 * removed by a deploy.
 *
 * Every prop is the assignment's identity: changing any of them removes
 * the tag from the old object and applies it to the new one. The object
 * must exist; schemas, tables and columns come from the source system.
 *
 * @see https://docs.starburst.io/starburst-galaxy/data-engineering/working-with-data-lakes/tags.html
 *
 * ### Tagging a catalog
 * **Example:** Mark a catalog as PII
 * ```typescript
 * const catalog = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "customers" });
 * const pii = yield* StarburstGalaxy.Governance.Tag("Pii", { color: "#FF0000" });
 * yield* StarburstGalaxy.Governance.TagAssignment("CustomersPii", {
 *   tag: pii.tagId,
 *   catalog: catalog.catalogId,
 * });
 * ```
 *
 * ### Tagging a column
 * **Example:** Mark one column as PII
 * ```typescript
 * const catalog = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "customers" });
 * const pii = yield* StarburstGalaxy.Governance.Tag("Pii", { color: "#FF0000" });
 * yield* StarburstGalaxy.Governance.TagAssignment("EmailPii", {
 *   tag: pii.tagId,
 *   catalog: catalog.catalogId,
 *   schema: "public",
 *   table: "users",
 *   column: "email",
 * });
 * ```
 *
 * @resource
 * @product Data governance
 */
export const TagAssignment = Resource<TagAssignment>("StarburstGalaxy.Governance.TagAssignment");

/** A table without its schema, or a column without its table. */
export class TagAssignmentTargetInvalid extends Data.TaggedError(
  "StarburstGalaxy.TagAssignmentTargetInvalid",
)<{
  readonly missing: "schema" | "table";
}> {
  override get message() {
    return `A tag assignment to a ${this.missing === "schema" ? "table" : "column"} needs its ${this.missing}`;
  }
}

/** An assignment's target as Galaxy names it. */
type Target = Omit<TagAssignmentAttributes, "tagName">;

const targetOf = (props: TagAssignmentProps): Target => ({
  tagId: props.tag,
  catalogId: props.catalog,
  schemaId: props.schema,
  tableId: props.table,
  columnId: props.column,
});

/** The tags on the target, read through the discovery service. */
const tagsOn = Effect.fn(function* (target: Target) {
  const { catalogId, schemaId, tableId, columnId } = target;
  if (schemaId === undefined) {
    const catalog = yield* galaxy.discovery.getCatalogMetadata({ catalogId });
    return catalog.tags;
  }
  if (tableId === undefined) {
    const schema = yield* galaxy.discovery.getCatalogSchema({ catalogId, schemaId });
    return schema.tags;
  }
  if (columnId === undefined) {
    const table = yield* galaxy.discovery.getCatalogSchemaTable({ catalogId, schemaId, tableId });
    return table.tags;
  }
  const column = yield* galaxy.discovery.getCatalogSchemaTableColumn({
    catalogId,
    schemaId,
    tableId,
    columnId,
  });
  return column.tags;
});

/** The assignment as Galaxy reports it; `undefined` when the tag, or the target, is gone. */
const observe = Effect.fn(function* (target: Target) {
  const tags = yield* tagsOn(target).pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  const applied = tags?.find((tag) => tag.tagId === target.tagId);
  return applied === undefined
    ? undefined
    : ({ ...target, tagName: applied.name } satisfies TagAssignmentAttributes);
});

const apply = Effect.fn(function* (target: Target) {
  const { tagId, catalogId, schemaId, tableId, columnId } = target;
  if (schemaId === undefined) {
    yield* galaxy.tag.applyCatalogTag({ tagId, catalogId });
  } else if (tableId === undefined) {
    yield* galaxy.tag.applyCatalogSchemaTag({ tagId, catalogId, schemaId });
  } else if (columnId === undefined) {
    yield* galaxy.tag.applyCatalogSchemaTableTag({ tagId, catalogId, schemaId, tableId });
  } else {
    yield* galaxy.tag.applyCatalogSchemaTableColumnTag({
      tagId,
      catalogId,
      schemaId,
      tableId,
      columnId,
    });
  }
});

const remove = Effect.fn(function* (target: Target) {
  const { tagId, catalogId, schemaId, tableId, columnId } = target;
  if (schemaId === undefined) {
    yield* galaxy.tag.removeCatalogTag({ tagId, catalogId });
  } else if (tableId === undefined) {
    yield* galaxy.tag.removeCatalogSchemaTag({ tagId, catalogId, schemaId });
  } else if (columnId === undefined) {
    yield* galaxy.tag.removeCatalogSchemaTableTag({ tagId, catalogId, schemaId, tableId });
  } else {
    yield* galaxy.tag.removeCatalogSchemaTableColumnTag({
      tagId,
      catalogId,
      schemaId,
      tableId,
      columnId,
    });
  }
});

export const TagAssignmentProvider = () =>
  Provider.succeed(TagAssignment, {
    stables: ["tagId", "tagName", "catalogId", "schemaId", "tableId", "columnId"],

    nuke: {
      // Remove assignments before the tags and catalogs they name.
      dependsOn: ["StarburstGalaxy.Governance.Tag", "StarburstGalaxy.Catalog.*"],
    },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (deepEqual(targetOf(olds), targetOf(news))) return undefined;
      return { action: "replace" } as const;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const assignment = yield* observe(output ?? targetOf(olds));
      if (assignment === undefined) return undefined;
      // An assignment has no name to carry an ownership marker.
      return output !== undefined ? assignment : Unowned(assignment);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      if (news.table !== undefined && news.schema === undefined) {
        return yield* new TagAssignmentTargetInvalid({ missing: "schema" });
      }
      if (news.column !== undefined && news.table === undefined) {
        return yield* new TagAssignmentTargetInvalid({ missing: "table" });
      }
      const target = targetOf(news);

      // Observe
      const observed = yield* observe(target);
      if (observed !== undefined) return observed;

      // Ensure: applying a tag that is already there is a race, not a failure.
      yield* session.note(`Applying tag ${target.tagId}...`);
      yield* apply(target).pipe(Effect.catchTag("Conflict", () => Effect.void));
      const applied = yield* observe(target);
      return applied ?? { ...target, tagName: "" };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* remove(output).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // Galaxy has no account-wide read of assignments: list the catalog-level
    // ones, which `getCatalogMetadata` reports for every catalog.
    // Assignments belong to their tag: deleting a tag Alchemy created removes them.
    list: () => Effect.succeed([]),
  });
