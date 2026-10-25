import * as tables from "@distilled.cloud/azure/cosmos-tables";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition, type RolePermission } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { StorageAccount } from "./StorageAccount.ts";
import type { Table } from "./Table.ts";
import type { ReadTableClient } from "./TableRead.ts";
import type {
  QueryTableEntitiesOptions,
  TableEntity,
  TableEntityRecord,
  UpdateTableEntityOptions,
} from "./TableTypes.ts";
import type { WriteTableClient } from "./TableWrite.ts";

/**
 * Shared scaffolding for the Azure Table storage bindings: resolves the
 * distilled `cosmos-tables` operations once when the layer is built, and at
 * deploy time assigns the binding's role on the bound table (or account).
 *
 * NOT exported from `index.ts`.
 */

/**
 * The role a binding assigns: a built-in role GUID, or a custom role with
 * exactly the binding's actions. A custom role is one
 * `Azure.Authorization.RoleDefinition` per binding kind and stack, defined
 * on the subscription and shared by every host that uses the binding.
 */
export type TableGrant =
  | { readonly builtInRole: string }
  | {
      /** Logical ID of the shared role definition. */
      readonly customRole: string;
      readonly description: string;
      readonly permissions: RolePermission;
    };

/** Escape a key for the `(PartitionKey='…',RowKey='…')` address. */
export const quoteTableKey = (key: string) => key.replace(/'/g, "''");

/**
 * The request's `partitionKey` / `rowKey`, quoted for the entity address;
 * empty when it has neither.
 */
export const quotedEntityKeys = (request: object) => {
  const { partitionKey, rowKey } = request as { partitionKey?: unknown; rowKey?: unknown };
  return {
    ...(typeof partitionKey === "string" ? { partitionKey: quoteTableKey(partitionKey) } : {}),
    ...(typeof rowKey === "string" ? { rowKey: quoteTableKey(rowKey) } : {}),
  };
};

/** An entity response without its OData metadata, with `etag` lifted out. */
export const toTableEntityRecord = (raw: Record<string, unknown>): TableEntityRecord => {
  const { "odata.metadata": _metadata, "odata.etag": etag, ...rest } = raw;
  return {
    ...(rest as TableEntity),
    etag: typeof etag === "string" ? etag : undefined,
  };
};

const GrantOn = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // The role definition is a deploy-time resource.
  const defineRole = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (
    tag: string,
    resource: Table | StorageAccount,
    scope: Input<string>,
    grant: TableGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      let roleDefinitionId: Input<string>;
      if ("builtInRole" in grant) {
        roleDefinitionId = grant.builtInRole;
      } else {
        const role = yield* defineRole!(grant.customRole, {
          description: grant.description,
          permissions: [grant.permissions],
        });
        roleDefinitionId = role.roleDefinitionId;
      }
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId, scope }],
      });
    }
  });
});

/** Where a table lives, resolved per call at runtime. */
export interface TableAddress {
  readonly tag: string;
  /** `https://{account}.table.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly table: Effect.Effect<string>;
}

const at = (address: TableAddress) => Effect.all({ url: address.url, table: address.table });

/**
 * Bind one table-scoped distilled operation: the runtime callable fills in
 * the table's endpoint and name; the deploy-time half assigns `grant` on
 * the table.
 */
export const makeTableOperationBinding = <I extends { url: string; table: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.GetTableEntity`. */
  tag: string;
  /** The distilled operation; `url` and `table` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  grant: TableGrant;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (table: Table) {
      yield* grantOn(options.tag, table, table.tableId, options.grant);
      const address = yield* tableAddress(options.tag, table);
      return Effect.fn(address.tag)(function* (request: Omit<I, "url" | "table">) {
        const where = yield* at(address);
        // `Omit<I, K> & Pick<I, K>` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, ...where, ...quotedEntityKeys(request) } as I);
      });
    });
  });

/**
 * Bind one account-scoped distilled operation (create, delete, or list
 * tables): the runtime callable fills in the account's table endpoint; the
 * deploy-time half assigns `grant` on the storage account.
 */
export const makeTableServiceOperationBinding = <I extends { url: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.CreateTable`. */
  tag: string;
  /** The distilled operation; `url` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  grant: TableGrant;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: StorageAccount) {
      yield* grantOn(options.tag, account, account.storageAccountId, options.grant);
      const url =
        yield* Output.interpolate`https://${account.storageAccountName}.table.core.windows.net`;
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (request: Omit<I, "url">) {
        const endpoint = yield* url;
        // `Omit<I, "url"> & Pick<I, "url">` is `I`, but TypeScript cannot prove it for a generic `I`.
        return yield* op({ ...request, url: endpoint } as I);
      });
    });
  });

const tableAddress = Effect.fn(function* (tag: string, table: Table) {
  const url = yield* Output.interpolate`https://${table.storageAccount}.table.core.windows.net`;
  const name = yield* table.tableName;
  return { tag: `${tag}(${table.LogicalId})`, url, table: name } satisfies TableAddress;
});

export const makeTableClients = Effect.gen(function* () {
  const getEntity = yield* AzureBindings.withCredentials(
    tables.TableQueryEntityWithPartitionAndRowKey,
  );
  const queryEntities = yield* AzureBindings.withCredentials(tables.TableQueryEntities);
  const insertEntity = yield* AzureBindings.withCredentials(tables.InsertTableEntity);
  const updateEntity = yield* AzureBindings.withCredentials(tables.UpdateTableEntity);
  const mergeEntity = yield* AzureBindings.withCredentials(tables.MergeTableEntity);
  const deleteEntity = yield* AzureBindings.withCredentials(tables.DeleteTableEntity);

  const keysOf = (entity: Pick<TableEntity, "PartitionKey" | "RowKey">) => ({
    partitionKey: quoteTableKey(entity.PartitionKey),
    rowKey: quoteTableKey(entity.RowKey),
  });

  const makeRead = (address: TableAddress): ReadTableClient => ({
    get: Effect.fn(`${address.tag}.get`)(function* (partitionKey: string, rowKey: string) {
      const where = yield* at(address);
      const found = yield* getEntity({
        ...where,
        ...keysOf({ PartitionKey: partitionKey, RowKey: rowKey }),
      }).pipe(Effect.catchTag("TableEntityNotFound", () => Effect.succeed(undefined)));
      return found === undefined ? undefined : toTableEntityRecord(found);
    }),
    query: Effect.fn(`${address.tag}.query`)(function* (options?: QueryTableEntitiesOptions) {
      const where = yield* at(address);
      const page = yield* queryEntities({
        ...where,
        _filter: options?.filter,
        _select: options?.select,
        _top: options?.top,
        NextPartitionKey: options?.continuation?.nextPartitionKey,
        NextRowKey: options?.continuation?.nextRowKey,
      });
      return {
        entities: (page.value ?? []).map((raw) => toTableEntityRecord(raw)),
        continuation:
          page.xMsContinuationNextPartitionKey === undefined
            ? undefined
            : {
                nextPartitionKey: page.xMsContinuationNextPartitionKey,
                nextRowKey: page.xMsContinuationNextRowKey,
              },
      };
    }),
  });

  const makeWrite = (address: TableAddress): WriteTableClient => ({
    insert: Effect.fn(`${address.tag}.insert`)(function* (entity: TableEntity) {
      const where = yield* at(address);
      const created = yield* insertEntity({ ...where, body: entity });
      return { etag: toTableEntityRecord(created).etag };
    }),
    upsert: Effect.fn(`${address.tag}.upsert`)(function* (
      entity: TableEntity,
      options?: { mode?: "replace" | "merge" },
    ) {
      const where = yield* at(address);
      // No If-Match: insert the entity, or replace / merge the existing one.
      const written =
        options?.mode === "merge"
          ? yield* mergeEntity({ ...where, ...keysOf(entity), body: entity })
          : yield* updateEntity({ ...where, ...keysOf(entity), body: entity });
      return { etag: written.eTag };
    }),
    update: Effect.fn(`${address.tag}.update`)(function* (
      entity: TableEntity,
      options?: UpdateTableEntityOptions & { mode?: "replace" | "merge" },
    ) {
      const where = yield* at(address);
      const ifMatch = options?.etag ?? "*";
      const written =
        options?.mode === "merge"
          ? yield* mergeEntity({ ...where, ...keysOf(entity), ifMatch, body: entity })
          : yield* updateEntity({ ...where, ...keysOf(entity), ifMatch, body: entity });
      return { etag: written.eTag };
    }),
    delete: Effect.fn(`${address.tag}.delete`)(function* (
      partitionKey: string,
      rowKey: string,
      options?: UpdateTableEntityOptions,
    ) {
      const where = yield* at(address);
      const keys = keysOf({ PartitionKey: partitionKey, RowKey: rowKey });
      if (options?.etag !== undefined) {
        yield* deleteEntity({ ...where, ...keys, ifMatch: options.etag });
        return;
      }
      // An unconditional delete of a missing entity succeeds.
      yield* deleteEntity({ ...where, ...keys, ifMatch: "*" }).pipe(
        Effect.catchTag("TableEntityNotFound", () => Effect.void),
      );
    }),
  });

  return { makeRead, makeWrite };
});

/**
 * Build a table binding that assigns `grant` on the table and returns the
 * client `makeClient` builds.
 */
export const makeTableBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.TableRead`. */
  tag: string;
  grant: TableGrant;
  makeClient: (helpers: Effect.Success<typeof makeTableClients>, address: TableAddress) => Client;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const helpers = yield* makeTableClients;
    return Effect.fn(function* (table: Table) {
      yield* grantOn(options.tag, table, table.tableId, options.grant);
      const address = yield* tableAddress(options.tag, table);
      return options.makeClient(helpers, address);
    });
  });
