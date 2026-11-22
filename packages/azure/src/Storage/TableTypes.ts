import type * as tables from "@distilled.cloud/azure/cosmos-tables";

/**
 * Data actions of the Azure Table storage data plane, as the bindings grant
 * them. Each binding's role carries exactly the ones its operations call.
 */
export const TableDataAction = {
  read: "Microsoft.Storage/storageAccounts/tableServices/tables/entities/read",
  add: "Microsoft.Storage/storageAccounts/tableServices/tables/entities/add/action",
  update: "Microsoft.Storage/storageAccounts/tableServices/tables/entities/update/action",
  delete: "Microsoft.Storage/storageAccounts/tableServices/tables/entities/delete",
} as const;

/** Control actions the table-level data-plane operations need on the account. */
export const TableAction = {
  read: "Microsoft.Storage/storageAccounts/tableServices/tables/read",
  write: "Microsoft.Storage/storageAccounts/tableServices/tables/write",
  delete: "Microsoft.Storage/storageAccounts/tableServices/tables/delete",
} as const;

/**
 * A table entity: its keys plus any properties. Property values are JSON
 * values; set `"<name>@odata.type"` (e.g. `"Edm.Int64"`) next to a property
 * to send it as another EDM type.
 */
export interface TableEntity {
  PartitionKey: string;
  RowKey: string;
  [property: string]: unknown;
}

/** An entity as read back: its properties, `Timestamp`, and `etag`. */
export interface TableEntityRecord extends TableEntity {
  /** Last-modified time the service sets. */
  Timestamp?: string;
  /** Pass to `update` / `delete` for an optimistic-concurrency write. */
  etag: string | undefined;
}

/** Options for one page of a table query. */
export interface QueryTableEntitiesOptions {
  /** OData filter, e.g. `PartitionKey eq 'orders' and total gt 10`. */
  filter?: string;
  /** Comma-separated properties to return. */
  select?: string;
  /** Entities per page (max 1,000). */
  top?: number;
  /** `continuation` from the previous page. */
  continuation?: TableQueryContinuation;
}

/** Where the next page of a query starts. */
export interface TableQueryContinuation {
  nextPartitionKey: string;
  nextRowKey: string | undefined;
}

/** One page of a table query. */
export interface QueryTableEntitiesResult {
  entities: TableEntityRecord[];
  /** Pass back as `continuation` to read the next page; absent on the last page. */
  continuation: TableQueryContinuation | undefined;
}

/** Options for `update` / `merge` writes. */
export interface UpdateTableEntityOptions {
  /**
   * Only write when the entity still has this ETag (from `get`, `query`, or
   * a previous write); fails with `TableEntityConditionNotMet` otherwise.
   * @default "*" (the entity must exist)
   */
  etag?: string;
}

/** Errors a table entity client can return. */
export type TableEntityError =
  | tables.InsertTableEntityError
  | tables.UpdateTableEntityError
  | tables.MergeTableEntityError
  | tables.DeleteTableEntityError
  | tables.TableQueryEntitiesError
  | tables.TableQueryEntityWithPartitionAndRowKeyError;
