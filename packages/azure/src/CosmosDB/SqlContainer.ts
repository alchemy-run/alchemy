import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  canonical,
  createOptions,
  hasDedicatedThroughput,
  isOwnedChild,
  syncThroughput,
  type ThroughputProps,
  waitForChild,
  whileAccountBusy,
} from "./Shared.ts";

export type IndexingPolicy = cosmos.IndexingPolicy;
export type ConflictResolutionPolicy = cosmos.ConflictResolutionPolicy;
export type VectorEmbeddingPolicy = cosmos.VectorEmbeddingPolicy;
export type FullTextPolicy = cosmos.FullTextPolicy;

export interface SqlContainerPartitionKey {
  /**
   * Partition key paths, e.g. `["/tenantId"]`. Up to three paths with
   * `kind: "MultiHash"` (hierarchical partition keys).
   */
  paths: string[];
  /**
   * Partitioning algorithm.
   * @default "Hash" for one path, "MultiHash" for several
   */
  kind?: "Hash" | "MultiHash";
  /**
   * Partition key definition version; `2` supports keys longer than 100 bytes.
   * @default 2
   */
  version?: 1 | 2;
}

export interface SqlContainerUniqueKey {
  /** Paths whose combined value must be unique within a logical partition. */
  paths: string[];
}

export interface SqlContainerComputedProperty {
  /** Name of the computed property, e.g. `cp_lowerName`. */
  name: string;
  /** Query that computes the value, e.g. `SELECT VALUE LOWER(c.name) FROM c`. */
  query: string;
}

export interface SqlContainerProps extends ThroughputProps {
  /**
   * Resource group of the account. Changing it replaces the container.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the Cosmos DB account. Changing it replaces the container. */
  account: string;
  /** Name of the SQL database, e.g. `database.databaseName`. Changing it replaces the container. */
  database: string;
  /**
   * Container name (up to 255 characters, no `/`, `\`, `#`, or `?`). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the container.
   */
  name?: string;
  /**
   * Partition key. Changing it replaces the container (and deletes its data).
   * @default { paths: ["/id"] }
   */
  partitionKey?: SqlContainerPartitionKey;
  /**
   * Indexing policy. Updates are applied in place; Cosmos rebuilds the
   * index in the background.
   * @default Azure's default (consistent indexing of every path)
   */
  indexingPolicy?: IndexingPolicy;
  /**
   * Default time to live for items in seconds; `-1` enables TTL without a
   * default expiry. Omit to disable TTL.
   * @default TTL disabled
   */
  defaultTtl?: number;
  /**
   * Analytical store TTL in seconds (`-1` keeps data forever). Needs
   * `enableAnalyticalStorage` on the account.
   * @default analytical store off
   */
  analyticalStorageTtl?: number;
  /**
   * Unique key constraints. Changing them replaces the container.
   * @default none
   */
  uniqueKeys?: SqlContainerUniqueKey[];
  /**
   * Conflict resolution for multi-region writes. Changing it replaces the container.
   * @default Azure's default (last writer wins on `/_ts`)
   */
  conflictResolutionPolicy?: ConflictResolutionPolicy;
  /**
   * Computed properties.
   * @default none
   */
  computedProperties?: SqlContainerComputedProperty[];
  /**
   * Vector embedding policy for vector search. Needs the
   * `EnableNoSQLVectorSearch` capability. Changing it replaces the container.
   * @default none
   */
  vectorEmbeddingPolicy?: VectorEmbeddingPolicy;
  /**
   * Full-text search policy. Needs the `EnableNoSQLFullTextSearch` capability.
   * @default none
   */
  fullTextPolicy?: FullTextPolicy;
}

export interface SqlContainer extends Resource<
  "Azure.CosmosDB.SqlContainer",
  SqlContainerProps,
  {
    /** Name of the container. */
    containerName: string;
    /** Name of the SQL database. */
    database: string;
    /** Name of the Cosmos DB account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the container. */
    containerId: string;
    /** System-generated resource ID (`_rid`). */
    rid: string | undefined;
    /** Partition key paths. */
    partitionKeyPaths: string[];
    /** Partitioning algorithm. */
    partitionKeyKind: string;
    /** Default item TTL in seconds, when enabled. */
    defaultTtl: number | undefined;
    /** Dedicated manual throughput in RU/s, when provisioned. */
    throughput: number | undefined;
    /** Dedicated autoscale maximum throughput in RU/s, when provisioned. */
    autoscaleMaxThroughput: number | undefined;
  },
  never,
  Providers
> {}

/**
 * A container in an Azure Cosmos DB for NoSQL database
 * (`Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers`): the
 * unit that holds your JSON documents, partitioned by a partition key and
 * indexed by an indexing policy.
 *
 * Every document needs an `id`, unique within its logical partition. Bind
 * the container to a runtime and the binding assigns a Cosmos DB data role
 * on this container only. Cosmos DB does not keep tags on containers;
 * Alchemy treats one it created (or one under a generated name) as its own.
 *
 * :::caution[Changing the partition key replaces the container]
 * So do `name`, `account`, `database`, `resourceGroup`, `uniqueKeys`,
 * `conflictResolutionPolicy`, `vectorEmbeddingPolicy`, and adding or
 * removing dedicated throughput. Alchemy creates a new, empty container and
 * deletes the old one with every document in it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/nosql/
 *
 * ### Creating a Container
 * **Example:** Container partitioned by owner
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   location: "centralus",
 *   capabilities: ["EnableServerless"],
 * });
 * const database = yield* Azure.CosmosDB.SqlDatabase("app", {
 *   account: account.accountName,
 * });
 * const todos = yield* Azure.CosmosDB.SqlContainer("todos", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/owner"] },
 * });
 * ```
 *
 * **Example:** Container partitioned by tenant
 * ```typescript
 * const orders = yield* Azure.CosmosDB.SqlContainer("orders", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId"] },
 * });
 * ```
 *
 * **Example:** Hierarchical partition key
 * ```typescript
 * const events = yield* Azure.CosmosDB.SqlContainer("events", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId", "/userId"], kind: "MultiHash" },
 * });
 * ```
 *
 * ### Expiry and Indexing
 * **Example:** Expire items after a day and index only one path
 * ```typescript
 * const sessions = yield* Azure.CosmosDB.SqlContainer("sessions", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/userId"] },
 *   defaultTtl: 86400,
 *   indexingPolicy: {
 *     indexingMode: "consistent",
 *     includedPaths: [{ path: "/userId/?" }],
 *     excludedPaths: [{ path: "/*" }],
 *   },
 * });
 * ```
 *
 * ### Dedicated Throughput
 * **Example:** Autoscale container on a provisioned account
 * ```typescript
 * const hot = yield* Azure.CosmosDB.SqlContainer("hot", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/id"] },
 *   autoscaleMaxThroughput: 4000,
 * });
 * ```
 *
 * ### Unique Keys and Computed Properties
 * **Example:** One email per tenant
 * ```typescript
 * const users = yield* Azure.CosmosDB.SqlContainer("users", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId"] },
 *   uniqueKeys: [{ paths: ["/email"] }],
 * });
 * ```
 *
 * **Example:** Query on a lowercase name
 * ```typescript
 * const users = yield* Azure.CosmosDB.SqlContainer("users", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/tenantId"] },
 *   computedProperties: [{ name: "cp_lowerName", query: "SELECT VALUE LOWER(c.name) FROM c" }],
 * });
 * ```
 *
 * ### Vector Search
 * **Example:** Container with a vector index
 * ```typescript
 * const account = yield* Azure.CosmosDB.DatabaseAccount("db", {
 *   capabilities: ["EnableServerless", "EnableNoSQLVectorSearch"],
 * });
 * const chunks = yield* Azure.CosmosDB.SqlContainer("chunks", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/documentId"] },
 *   vectorEmbeddingPolicy: {
 *     vectorEmbeddings: [
 *       { path: "/embedding", dataType: "float32", distanceFunction: "cosine", dimensions: 1536 },
 *     ],
 *   },
 *   indexingPolicy: {
 *     indexingMode: "consistent",
 *     includedPaths: [{ path: "/*" }],
 *     excludedPaths: [{ path: "/embedding/*" }],
 *     vectorIndexes: [{ path: "/embedding", type: "diskANN" }],
 *   },
 * });
 * ```
 *
 * ### Binding to a runtime
 * `SqlContainerRead` assigns the built-in **Cosmos DB Built-in Data
 * Reader** role on this container. `SqlContainerWrite` (create, upsert,
 * replace, patch, delete) and `SqlContainerReadWrite` assign a custom data
 * role with exactly the actions their client calls. The role goes to the
 * host's managed identity on an Azure Function, Web App, Container App,
 * container group, or VM, and to an Entra service principal on any other
 * host.
 *
 * **Example:** A todo API on Azure Functions
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const todosContainer = yield* Todos;
 *     const todos = yield* Azure.CosmosDB.SqlContainerReadWrite(todosContainer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const page = yield* todos.query({
 *           query: "SELECT * FROM c WHERE c.owner = @owner",
 *           parameters: [{ name: "@owner", value: "sam" }],
 *           partitionKey: ["sam"],
 *         });
 *         return yield* HttpServerResponse.json({ todos: page.Documents ?? [] });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Azure.CosmosDB.SqlContainerReadWriteHttp)),
 * ) {}
 * ```
 *
 * **Example:** Read-only access
 * ```typescript
 * // init
 * const changes = yield* Azure.CosmosDB.SqlContainerRead(changesContainer);
 *
 * // runtime
 * const { document } = yield* changes.get({ documentId: id, partitionKey: [owner] });
 * // …provided with Effect.provide(Azure.CosmosDB.SqlContainerReadHttp)
 * ```
 *
 * ### Runtime Operations
 * **Example:** Create and read a document
 * ```typescript
 * const todo = { id: crypto.randomUUID(), owner: "sam", title: "ship", done: false };
 * const created = yield* todos.create({ document: todo, partitionKey: [todo.owner] });
 * const { document, etag } = yield* todos.get({ documentId: todo.id, partitionKey: ["sam"] });
 * ```
 *
 * **Example:** Patch with optimistic concurrency
 * ```typescript
 * yield* todos
 *   .patch({
 *     documentId: id,
 *     partitionKey: [owner],
 *     operations: [{ op: "set", path: "/done", value: true }],
 *     ifMatch: etag,
 *   })
 *   .pipe(
 *     Effect.catchTag("CosmosNotFound", () => Effect.void),
 *     Effect.catchTag("CosmosPreconditionFailed", () => Effect.log("changed since read")),
 *   );
 * ```
 *
 * **Example:** Upsert, replace, and delete
 * ```typescript
 * yield* todos.upsert({ document: todo, partitionKey: [todo.owner] });
 * yield* todos.replace({ documentId: todo.id, document: { ...todo, done: true }, partitionKey: [todo.owner] });
 * yield* todos.delete({ documentId: todo.id, partitionKey: [todo.owner] });
 * ```
 *
 * **Example:** Page through a partition
 * ```typescript
 * const first = yield* todos.list({ partitionKey: ["sam"], maxItemCount: 100 });
 * const next = first.continuation
 *   ? yield* todos.list({ partitionKey: ["sam"], continuation: first.continuation })
 *   : undefined;
 * ```
 *
 * ### Event Sources
 * `consumeChangeFeed` runs a handler on each batch of created or updated
 * documents (deletes are not in the feed). It needs a lease container
 * (partition key `/id`) in the same database.
 *
 * **Example:** Copy each changed todo in an Azure Function
 * ```typescript
 * export default class Worker extends Azure.Functions.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const leases = yield* Leases;
 *     const changesContainer = yield* Changes;
 *     const changes = yield* Azure.CosmosDB.SqlContainerWrite(changesContainer);
 *     yield* Azure.CosmosDB.consumeChangeFeed(Todos, { leases }, (documents) =>
 *       Effect.forEach(documents, (document) =>
 *         changes.upsert({ document, partitionKey: [String(document.owner)] }),
 *       ).pipe(Effect.orDie, Effect.asVoid),
 *     );
 *     return { fetch: Effect.succeed(HttpServerResponse.text("ok")) };
 *   }).pipe(
 *     Effect.provide([Azure.Functions.CosmosDBChangeFeedEventSource, Azure.CosmosDB.SqlContainerWriteHttp]),
 *   ),
 * ) {}
 * ```
 *
 * The trigger starts once the app's data role applies, a few minutes after
 * the first deploy. Set `startFromBeginning` so documents written before
 * that are not skipped.
 *
 * **Example:** Read changes made before the trigger started
 * ```typescript
 * yield* Azure.CosmosDB.consumeChangeFeed(orders, { leases, startFromBeginning: true }, (documents) =>
 *   Effect.log(`${documents.length} orders`),
 * );
 * ```
 *
 * ### Deleting a Container
 * Destroying the container deletes every document in it.
 *
 * **Example:** Keep the container when the stack is destroyed
 * ```typescript
 * import * as RemovalPolicy from "alchemy/RemovalPolicy";
 *
 * const todos = yield* Azure.CosmosDB.SqlContainer("todos", {
 *   account: account.accountName,
 *   database: database.databaseName,
 *   partitionKey: { paths: ["/owner"] },
 * }).pipe(RemovalPolicy.retain());
 * ```
 *
 * @resource
 */
export const SqlContainer = GroupedResource<SqlContainer>("Azure.CosmosDB.SqlContainer");

type ObservedContainer = cosmos.GetSqlResourceSqlContainerResponse;

const createContainerName = (id: string) => createPhysicalName({ id, maxLength: 255 });

const getContainer = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  databaseName: string,
  containerName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetSqlResourceSqlContainer({
      subscriptionId,
      resourceGroupName,
      accountName,
      databaseName,
      containerName,
    }),
  );

const desiredPartitionKey = (props: SqlContainerProps): Required<SqlContainerPartitionKey> => {
  const paths = props.partitionKey?.paths ?? ["/id"];
  return {
    paths,
    kind: props.partitionKey?.kind ?? (paths.length > 1 ? "MultiHash" : "Hash"),
    version: props.partitionKey?.version ?? 2,
  };
};

/** Cosmos always excludes the system `_etag` path; ignore it when comparing. */
const ETAG_PATH = '/"_etag"/?';

/** Whether the observed indexing policy matches every key the user set. */
const indexingMatches = (
  desired: IndexingPolicy | undefined,
  observed: IndexingPolicy | undefined,
) => {
  if (desired === undefined) return true;
  return (Object.keys(desired) as (keyof IndexingPolicy)[]).every((key) => {
    let value: unknown = observed?.[key];
    if (key === "excludedPaths" && Array.isArray(value)) {
      value = (value as { path?: string }[]).filter((p) => p.path !== ETAG_PATH);
    }
    const want =
      key === "excludedPaths"
        ? (desired.excludedPaths ?? []).filter((p) => p.path !== ETAG_PATH)
        : desired[key];
    return canonical(want ?? []) === canonical(value ?? []);
  });
};

/** True when the observed container differs from the mutable desired state. */
const mutableDrift = (props: SqlContainerProps, observed: ObservedContainer) => {
  const resource = observed.properties?.resource;
  return (
    resource?.defaultTtl !== props.defaultTtl ||
    (props.analyticalStorageTtl !== undefined &&
      resource?.analyticalStorageTtl !== props.analyticalStorageTtl) ||
    !indexingMatches(props.indexingPolicy, resource?.indexingPolicy) ||
    canonical(props.computedProperties ?? []) !== canonical(resource?.computedProperties ?? []) ||
    (props.fullTextPolicy !== undefined &&
      canonical(props.fullTextPolicy) !== canonical(resource?.fullTextPolicy))
  );
};

const toAttrs = (
  resourceGroup: string,
  account: string,
  database: string,
  name: string,
  container: ObservedContainer,
  throughput: ThroughputProps,
): SqlContainer["Attributes"] => {
  const resource = container.properties?.resource;
  return {
    containerName: name,
    database,
    account,
    resourceGroup,
    containerId: container.id ?? "",
    rid: resource?._rid,
    partitionKeyPaths: [...(resource?.partitionKey?.paths ?? [])],
    partitionKeyKind: resource?.partitionKey?.kind ?? "Hash",
    defaultTtl: resource?.defaultTtl,
    throughput: throughput.throughput,
    autoscaleMaxThroughput: throughput.autoscaleMaxThroughput,
  };
};

export const SqlContainerProvider = () =>
  Provider.succeed(SqlContainer, {
    stables: [
      "containerName",
      "database",
      "account",
      "resourceGroup",
      "containerId",
      "rid",
      "partitionKeyPaths",
      "partitionKeyKind",
    ],

    // Containers disappear with their database.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const partitionKey = desiredPartitionKey(news);
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.account !== output.account ||
        news.database !== output.database ||
        (news.name !== undefined && news.name !== output.containerName) ||
        partitionKey.paths.join(",") !== output.partitionKeyPaths.join(",") ||
        partitionKey.kind !== output.partitionKeyKind ||
        canonical(news.uniqueKeys ?? []) !== canonical(olds?.uniqueKeys ?? []) ||
        canonical(news.conflictResolutionPolicy) !== canonical(olds?.conflictResolutionPolicy) ||
        canonical(news.vectorEmbeddingPolicy) !== canonical(olds?.vectorEmbeddingPolicy) ||
        hasDedicatedThroughput(news) !== hasDedicatedThroughput(output)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const database = output?.database ?? olds?.database;
      if (resourceGroup === undefined || account === undefined || database === undefined) {
        return undefined;
      }
      const name = output?.containerName ?? olds?.name ?? (yield* createContainerName(id));
      const observed = yield* getContainer(subscriptionId, resourceGroup, account, database, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, database, name, observed, {
        throughput: output?.throughput,
        autoscaleMaxThroughput: output?.autoscaleMaxThroughput,
      });
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, account, database } = news;
      const name = news.name ?? output?.containerName ?? (yield* createContainerName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        databaseName: database,
        containerName: name,
      };
      const label = `Cosmos DB container ${name}`;
      const get = getContainer(subscriptionId, resourceGroup, account, database, name);
      const converged = (container: ObservedContainer) => !mutableDrift(news, container);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the whole container definition, so
      // immutable aspects are re-sent as observed; throughput in `options`
      // only applies at creation.
      if (observed === undefined || !converged(observed)) {
        const current = observed?.properties?.resource;
        const partitionKey = current?.partitionKey
          ? {
              paths: current.partitionKey.paths,
              kind: current.partitionKey.kind,
              version: current.partitionKey.version,
            }
          : desiredPartitionKey(news);
        yield* cosmos
          .SqlResourcesCreateUpdateSqlContainer({
            ...where,
            properties: {
              resource: {
                id: name,
                partitionKey,
                indexingPolicy: news.indexingPolicy,
                defaultTtl: news.defaultTtl,
                analyticalStorageTtl: news.analyticalStorageTtl,
                uniqueKeyPolicy: current
                  ? current.uniqueKeyPolicy
                  : news.uniqueKeys
                    ? { uniqueKeys: news.uniqueKeys }
                    : undefined,
                conflictResolutionPolicy: current
                  ? current.conflictResolutionPolicy
                  : news.conflictResolutionPolicy,
                vectorEmbeddingPolicy: current
                  ? current.vectorEmbeddingPolicy
                  : news.vectorEmbeddingPolicy,
                computedProperties: news.computedProperties,
                fullTextPolicy: news.fullTextPolicy,
              },
              options: observed === undefined ? createOptions(news) : undefined,
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
        observed = yield* waitForChild(label, get, converged);
      }

      // Sync dedicated throughput against observed throughput settings.
      const throughput = yield* syncThroughput(label, news, {
        get: cosmos.GetSqlResourceSqlContainerThroughput(where),
        update: (resource) =>
          cosmos.UpdateSqlResourceSqlContainerThroughput({
            ...where,
            properties: { resource },
          }),
        toAutoscale: cosmos.MigrateSqlResourceSqlContainerToAutoscale(where),
        toManual: cosmos.MigrateSqlResourceSqlContainerToManualThroughput(where),
      });

      return toAttrs(resourceGroup, account, database, name, observed, throughput);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        databaseName: output.database,
        containerName: output.containerName,
      };
      yield* ignoreNotFound(
        cosmos.DeleteSqlResourceSqlContainer(where).pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB container ${output.containerName}`,
        getContainer(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.database,
          output.containerName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.SqlDatabase",
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
