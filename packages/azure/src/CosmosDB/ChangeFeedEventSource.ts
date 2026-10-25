import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { SqlContainer } from "./SqlContainer.ts";

export interface ChangeFeedEventSourceProps {
  /**
   * Container that stores the change feed's leases (partition key `/id`),
   * in the same database. The Functions host cannot create it with a
   * managed identity, so it must exist.
   */
  leases: SqlContainer;
  /**
   * Read changes made before the first deploy too.
   * @default false
   */
  startFromBeginning?: boolean;
  /**
   * Name of the trigger function on the host (letters, digits, `_`, `-`).
   * @default `cosmos-<container logical ID>`
   */
  functionName?: string;
}

export type ChangeFeedEventSourceService = <Req = never>(
  container: SqlContainer,
  props: ChangeFeedEventSourceProps,
  handler: (documents: Record<string, unknown>[]) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void>;

/**
 * Event source that runs a handler on the change feed of a Cosmos DB for
 * NoSQL {@link SqlContainer}: each batch holds the documents created or
 * updated since the last one (deletes are not in the feed).
 *
 * Consume it with {@link consumeChangeFeed} and provide the host's
 * implementation: `Azure.Functions.CosmosDBChangeFeedEventSource` (a
 * native `cosmosDBTrigger` function). The host connects with its managed
 * identity, which gets the **Cosmos DB Built-in Data Contributor** data
 * role on the account (Cosmos DB data roles cannot be scoped to one
 * container for a change-feed reader that also writes leases).
 *
 * ### Reading the Change Feed
 * **Example:** Log changed orders
 * ```typescript
 * const leases = yield* Azure.CosmosDB.SqlContainer("Leases", {
 *   account: account.accountName,
 *   database: db.databaseName,
 *   partitionKey: { paths: ["/id"] },
 * });
 * yield* Azure.CosmosDB.consumeChangeFeed(orders, { leases }, (documents) =>
 *   Effect.log(`${documents.length} orders changed`),
 * );
 * // …provided with Effect.provide(Azure.Functions.CosmosDBChangeFeedEventSource)
 * ```
 *
 * @binding
 * @category CosmosDB
 */
export interface ChangeFeedEventSource extends Binding.Service<
  ChangeFeedEventSource,
  "Azure.CosmosDB.ChangeFeedEventSource",
  ChangeFeedEventSourceService
> {}

export const ChangeFeedEventSource = Binding.Service<ChangeFeedEventSource>(
  "Azure.CosmosDB.ChangeFeedEventSource",
);

/**
 * Run `handler` for each batch of changed documents in `container`.
 *
 * @example
 * ```typescript
 * yield* Azure.CosmosDB.consumeChangeFeed(orders, { leases }, (docs) => Effect.log(docs));
 * ```
 */
export const consumeChangeFeed = <C extends SqlContainer, Req = never, ContainerReq = never>(
  container: C | Effect.Effect<C, never, ContainerReq>,
  props: ChangeFeedEventSourceProps,
  handler: (documents: Record<string, unknown>[]) => Effect.Effect<void, never, Req>,
): Effect.Effect<void, never, ChangeFeedEventSource | ContainerReq> =>
  (Effect.isEffect(container) ? container : Effect.succeed(container)).pipe(
    Effect.flatMap((value) =>
      ChangeFeedEventSource.use((source) => source(value, props, handler)),
    ),
  );
