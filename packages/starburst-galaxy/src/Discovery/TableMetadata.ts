import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Column, Table } from "@distilled.cloud/starburst-galaxy/discovery";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { type Contact, contactsOf } from "../Contact.ts";
import { collectAll } from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface TableMetadataProps {
  /** ID of the catalog holding the table. Changing it replaces the resource. */
  readonly catalogId: string;
  /** Schema holding the table. Changing it replaces the resource. */
  readonly schemaName: string;
  /** Name of the table (or view) to annotate. Changing it replaces the resource. */
  readonly tableName: string;
  /**
   * Description the catalog explorer shows for the table.
   * @default ""
   */
  readonly description?: string;
  /**
   * People to ask about the table.
   * @default []
   */
  readonly contacts?: ReadonlyArray<Contact>;
  /**
   * Descriptions of columns, by column name. Columns left out keep their
   * description; a column removed from this map has its description
   * cleared on the next deploy.
   * @default {}
   */
  readonly columnDescriptions?: Readonly<Record<string, string>>;
}

/** A column of the table, as Galaxy reports it. */
export interface TableMetadataColumn {
  /** Column name. */
  readonly name: string;
  /** Trino data type, e.g. `decimal(10,2)`. */
  readonly dataType: string | undefined;
  /** Whether the column takes NULL. */
  readonly nullable: boolean;
  /** The column's description. */
  readonly description: string | undefined;
}

export interface TableMetadataAttributes {
  /** Catalog holding the table. */
  readonly catalogId: string;
  /** Schema holding the table. */
  readonly schemaName: string;
  /** The annotated table. */
  readonly tableName: string;
  /** `BASE TABLE`, `VIEW`, … */
  readonly tableType: string | undefined;
  /** Description the catalog explorer shows. */
  readonly description: string | undefined;
  /** People to ask about the table. */
  readonly contacts: ReadonlyArray<Contact>;
  /** The table's columns. */
  readonly columns: ReadonlyArray<TableMetadataColumn>;
}

export type TableMetadata = Resource<
  "StarburstGalaxy.TableMetadata",
  TableMetadataProps,
  TableMetadataAttributes,
  never,
  Providers
>;

/**
 * The description, contacts and column descriptions Starburst Galaxy's
 * catalog explorer shows for a table. The table itself comes from the
 * catalog's data source (a migration, a live table): this resource only
 * documents it.
 *
 * Everything but the catalog, schema and table updates in place, column
 * descriptions with one bulk call. `destroy` clears the description,
 * contacts and declared column descriptions, and leaves the table.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/explore-data/table-level.html
 *
 * ### Documenting a table and its columns
 * **Example:** What each column of an orders table means
 * ```typescript
 * const shop = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.TableMetadata("OrdersDocs", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   tableName: "orders",
 *   description: "One row per order",
 *   columnDescriptions: {
 *     amount: "Order total in USD, tax included",
 *     placed_at: "When the customer paid",
 *   },
 * });
 * ```
 *
 * @resource
 * @product Discovery
 */
export const TableMetadata = Resource<TableMetadata>("StarburstGalaxy.TableMetadata");

interface TableIds {
  readonly catalogId: string;
  readonly schemaId: string;
  readonly tableId: string;
}

const idsOf = (props: {
  readonly catalogId: string;
  readonly schemaName: string;
  readonly tableName: string;
}): TableIds => ({
  catalogId: props.catalogId,
  schemaId: props.schemaName,
  tableId: props.tableName,
});

const columnsOf = (ids: TableIds) =>
  collectAll(galaxy.discovery.listCatalogSchemaTableColumns.items(ids), (column: Column) => ({
    name: column.columnId,
    dataType: column.dataType,
    nullable: column.nullable,
    description: column.description,
  }));

const toAttributes = (
  ids: TableIds,
  table: Table,
  columns: ReadonlyArray<TableMetadataColumn>,
): TableMetadataAttributes => ({
  catalogId: ids.catalogId,
  schemaName: ids.schemaId,
  tableName: ids.tableId,
  tableType: table.tableType,
  description: table.description,
  contacts: contactsOf(table.contacts),
  columns,
});

/** Clear one column's description: Galaxy's column-metadata delete keeps the column. */
const clearColumn = (ids: TableIds, columnId: string) =>
  galaxy.discovery.deleteCatalogSchemaTableColumn({ ...ids, columnId }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () => Effect.void),
  );

export const TableMetadataProvider = () =>
  Provider.succeed(TableMetadata, {
    stables: ["catalogId", "schemaName", "tableName"],

    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        news.catalogId !== olds.catalogId ||
        news.schemaName !== olds.schemaName ||
        news.tableName !== olds.tableName
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const ids = idsOf(output);
      const table = yield* galaxy.discovery
        .getCatalogSchemaTable(ids)
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (table === undefined) return undefined;
      return toAttributes(ids, table, yield* columnsOf(ids));
    }),

    reconcile: Effect.fn(function* ({ news, olds, session }) {
      const ids = idsOf(news);
      // A missing table fails with Galaxy's typed NotFound.
      let table = yield* galaxy.discovery.getCatalogSchemaTable(ids);

      const description = news.description ?? "";
      const contacts = contactsOf(news.contacts);
      const patch = {
        ...((table.description ?? "") !== description ? { description } : {}),
        ...(!deepEqual(contactsOf(table.contacts), contacts) ? { contacts } : {}),
      };
      if (Object.keys(patch).length > 0) {
        yield* session.note(`Documenting table ${news.schemaName}.${news.tableName}...`);
        table = yield* galaxy.discovery.updateCatalogSchemaTable({ ...ids, ...patch });
      }

      // Declared column descriptions, in one bulk call; dropped ones are cleared.
      const declared = news.columnDescriptions ?? {};
      let columns = yield* columnsOf(ids);
      const changed = Object.fromEntries(
        Object.entries(declared).filter(
          ([name, text]) => columns.find((column) => column.name === name)?.description !== text,
        ),
      );
      const dropped = Object.keys(olds?.columnDescriptions ?? {}).filter(
        (name) => !(name in declared),
      );
      if (Object.keys(changed).length > 0 || dropped.length > 0) {
        yield* session.note(`Documenting the columns of ${news.schemaName}.${news.tableName}...`);
        if (Object.keys(changed).length > 0) {
          yield* galaxy.discovery.updateCatalogSchemaTableColumns({
            ...ids,
            descriptions: changed,
          });
        }
        yield* Effect.forEach(dropped, (name) => clearColumn(ids, name), { discard: true });
        columns = yield* columnsOf(ids);
      }

      return toAttributes(ids, table, columns);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const ids = idsOf(output);
      const table = yield* galaxy.discovery
        .getCatalogSchemaTable(ids)
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (table === undefined) return;
      yield* galaxy.discovery.updateCatalogSchemaTable({ ...ids, description: "", contacts: [] });
      yield* Effect.forEach(
        Object.keys(olds.columnDescriptions ?? {}),
        (name) => clearColumn(ids, name),
        { discard: true },
      );
    }),

    list: () => Effect.succeed([]),
  });
