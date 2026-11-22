import * as storage from "@distilled.cloud/azure/storage";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  accessPoliciesDiffer,
  fromSignedIdentifiers,
  isAccountOwnedByStack,
  toSignedIdentifiers,
  type StorageAccessPolicy,
} from "./StorageOwnership.ts";

export interface TableProps {
  /**
   * Resource group of the storage account. Changing it replaces the table.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Storage account that holds the table. Changing it replaces the table. */
  storageAccount: string;
  /**
   * Table name: 3-63 letters and digits, starting with a letter (no
   * hyphens). If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the table.
   */
  name?: string;
  /**
   * Stored access policies (at most 5) that shared access signatures can
   * reference. Table permissions are `r` (query), `a` (add), `u` (update),
   * and `d` (delete).
   * @default []
   */
  accessPolicies?: StorageAccessPolicy[];
}

export interface Table extends Resource<
  "Azure.Storage.Table",
  TableProps,
  {
    /** Name of the table. */
    tableName: string;
    /** Storage account that holds the table. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** ARM resource ID of the table; use it as a role-assignment scope. */
    tableId: string;
    /** Stored access policies on the table. */
    accessPolicies: StorageAccessPolicy[];
  },
  never,
  Providers
> {}

/**
 * An Azure Table storage table (`Microsoft.Storage/storageAccounts/tableServices/tables`):
 * a schemaless key/attribute store inside a Storage account. Each entity
 * has a `PartitionKey`, a `RowKey`, and up to 252 properties.
 *
 * Use it for cheap lookups by key, such as metadata, sessions, or
 * counters. For queries across partitions, secondary indexes, or global
 * replication, use `Azure.CosmosDB.SqlContainer`. Tables carry neither tags
 * nor metadata, so Alchemy treats a table as owned when its storage
 * account is tagged for the current stack and stage and the table has the
 * deterministic name.
 *
 * :::caution[Changing `name`, `storageAccount`, or `resourceGroup` replaces the table]
 * Alchemy creates a new, empty table and deletes the old one with every
 * entity in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/storage/tables/table-storage-overview
 *
 * ### Creating a Table
 * **Example:** Basic table
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("app");
 * const users = yield* Azure.Storage.Table("users", {
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Table with a fixed name
 * ```typescript
 * const users = yield* Azure.Storage.Table("users", {
 *   storageAccount: account.storageAccountName,
 *   name: "Users",
 * });
 * ```
 *
 * ### Binding to a runtime
 * Each binding grants a role on this table only. `TableRead` grants
 * **Storage Table Data Reader**. `TableWrite` (insert, update, delete,
 * no reads) and `TableReadWrite` grant a custom role with exactly the data
 * actions their client calls. On an Azure Function, Web App, Container
 * App, container group, or VM the role goes to the host's managed
 * identity; any other host gets an Entra service principal.
 *
 * **Example:** Read and write entities from an Azure Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const files = yield* Files;
 *     const records = yield* Azure.Storage.TableReadWrite(files);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* records.query({ filter: "PartitionKey eq 'files'", top: 100 });
 *         return yield* HttpServerResponse.json({ files: page.entities });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.Storage.TableReadWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Write-only access for a background indexer
 * ```typescript
 * // init
 * const records = yield* Azure.Storage.TableWrite(files);
 *
 * // runtime
 * yield* records.upsert({ PartitionKey: "files", RowKey: name, size, sha256 });
 * // …provided with Effect.provide(Azure.Storage.TableWriteHttp)
 * ```
 *
 * ### Runtime Operations
 * **Example:** Read one entity
 * ```typescript
 * // init
 * const users = yield* Azure.Storage.TableRead(table);
 *
 * // runtime
 * const user = yield* users.get("users", userId); // undefined when missing
 * // …provided with Effect.provide(Azure.Storage.TableReadHttp)
 * ```
 *
 * **Example:** Page through a partition
 * ```typescript
 * let continuation: Azure.Storage.TableQueryContinuation | undefined;
 * do {
 *   const page = yield* users.query({ filter: "PartitionKey eq 'users'", continuation });
 *   for (const user of page.entities) yield* Effect.log(user.RowKey);
 *   continuation = page.continuation;
 * } while (continuation);
 * ```
 *
 * **Example:** Insert, then update with optimistic concurrency
 * ```typescript
 * const { etag } = yield* counters.insert({ PartitionKey: "counters", RowKey: "hits", n: 1 });
 * yield* counters.update({ PartitionKey: "counters", RowKey: "hits", n: 2 }, { etag });
 * // a stale etag fails with TableEntityConditionNotMet
 * ```
 *
 * **Example:** Merge one property and delete an entity
 * ```typescript
 * yield* counters.upsert({ PartitionKey: "counters", RowKey: "hits", lastSeen: now }, { mode: "merge" });
 * yield* counters.delete("counters", "old"); // succeeds when already gone
 * ```
 *
 * ### Access Policies
 * **Example:** Stored access policy for read-only SAS tokens
 * ```typescript
 * const users = yield* Azure.Storage.Table("users", {
 *   storageAccount: account.storageAccountName,
 *   accessPolicies: [
 *     { id: "readers", permission: "r", expiryTime: "2030-01-01T00:00:00Z" },
 *   ],
 * });
 * ```
 *
 * ### Deleting a Table
 * Destroying the table deletes every entity in it. Azure finishes the
 * delete in the background, which takes at least 40 seconds; until then,
 * creating a table with the same name fails.
 *
 * **Example:** Keep the table when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const users = yield* Azure.Storage.Table("users", {
 *   storageAccount: account.storageAccountName,
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const Table = GroupedResource<Table>("Azure.Storage.Table");

const createTableName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
    delimiter: "",
  });
  const alnum = name.replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(alnum) ? alnum : `t${alnum}`.slice(0, 63);
});

const getTable = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  tableName: string,
) =>
  orUndefinedIfNotFound(
    storage.GetTable({
      subscriptionId,
      resourceGroupName,
      accountName,
      tableName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  name: string,
  table: storage.GetTableResponse,
): Table["Attributes"] => ({
  tableName: name,
  storageAccount,
  resourceGroup,
  tableId: table.id ?? "",
  accessPolicies: fromSignedIdentifiers(table.properties?.signedIdentifiers),
});

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: ["tableName", "storageAccount", "resourceGroup", "tableId"],

    // Tables live inside a storage account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.name !== undefined && news.name.toLowerCase() !== output.tableName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const name = output?.tableName ?? olds?.name ?? (yield* createTableName(id));
      const observed = yield* getTable(subscriptionId, resourceGroup, storageAccount, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, name, observed);
      return (yield* isAccountOwnedByStack(subscriptionId, resourceGroup, storageAccount))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const name = news.name ?? output?.tableName ?? (yield* createTableName(id));
      const desired = news.accessPolicies ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: storageAccount,
        tableName: name,
      };
      const get = getTable(subscriptionId, resourceGroup, storageAccount, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync access policies against the observed table.
      if (observed === undefined) {
        yield* storage.CreateTable({
          ...where,
          properties:
            desired.length > 0 ? { signedIdentifiers: toSignedIdentifiers(desired) } : undefined,
        });
      } else if (accessPoliciesDiffer(observed.properties?.signedIdentifiers, desired)) {
        yield* storage.UpdateTable({
          ...where,
          properties: { signedIdentifiers: toSignedIdentifiers(desired) },
        });
      }

      const fresh = yield* waitForProvisioned(`table ${name}`, get, () => undefined, {
        interval: "2 seconds",
        times: 15,
      });
      return toAttrs(resourceGroup, storageAccount, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteTable({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          tableName: output.tableName,
        }),
      );
      yield* waitUntilGone(
        `table ${output.tableName}`,
        getTable(subscriptionId, output.resourceGroup, output.storageAccount, output.tableName),
      );
    }),
  });
