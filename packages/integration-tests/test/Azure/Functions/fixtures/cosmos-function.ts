import * as Azure from "@alchemy.run/azure";
import * as cosmos from "@distilled.cloud/azure/cosmos-nosql";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { distilledFromSource } from "./distilled-source.ts";

/**
 * Cosmos DB region: free-trial serverless accounts in `eastus` sat in
 * `Creating` for 25+ minutes; `centralus` provisions in about a minute.
 */
const COSMOS_LOCATION = "centralus";

export const CosmosAccount = Azure.CosmosDB.DatabaseAccount("FnCosmosAccount", {
  location: COSMOS_LOCATION,
  capabilities: ["EnableServerless"],
});
export const CosmosDatabase = Effect.gen(function* () {
  const account = yield* CosmosAccount;
  return yield* Azure.CosmosDB.SqlDatabase("FnCosmosDatabase", { account: account.accountName });
});
const sqlContainer = (id: string) =>
  Effect.gen(function* () {
    const account = yield* CosmosAccount;
    const database = yield* CosmosDatabase;
    return yield* Azure.CosmosDB.SqlContainer(id, {
      account: account.accountName,
      database: database.databaseName,
      partitionKey: { paths: ["/id"] },
    });
  });
/** Watched by the change feed trigger. */
export const CosmosOrders = sqlContainer("FnCosmosOrders");
/** Holds the change feed's leases. */
export const CosmosLeases = sqlContainer("FnCosmosLeases");

export const CosmosResultsAccount = Azure.Storage.StorageAccount("FnCosmosData");
/** Where the change feed handler records each document id (`cosmos/<id>`). */
export const CosmosResults = Effect.gen(function* () {
  const account = yield* CosmosResultsAccount;
  return yield* Azure.Storage.BlobContainer("FnCosmosResults", {
    storageAccount: account.storageAccountName,
  });
});

const text = (body: string, status = 200) => HttpServerResponse.text(body, { status });

const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

/**
 * Effect Function with a Cosmos DB change feed trigger. `/cosmos/write?id=…`
 * creates a document with the app's managed identity (the event source
 * assigns it the Cosmos DB Built-in Data Contributor role); the handler
 * records `cosmos/<id>` in {@link CosmosResults}, read back with
 * `GET /result?key=…`.
 */
export default class CosmosFunction extends Azure.Functions.Function<CosmosFunction>()(
  "CosmosFunction",
  {
    main: import.meta.url,
    // TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const orders = yield* CosmosOrders;
    const leases = yield* CosmosLeases;
    const resultsContainer = yield* CosmosResults;
    const results = yield* Azure.Storage.BlobContainerReadWrite(resultsContainer);
    const accountName = yield* orders.account;
    const databaseName = yield* orders.database;
    const containerName = yield* orders.containerName;
    // Runs as the app's managed identity once deployed.
    const createDocument = yield* Azure.AzureBindings.withCredentials(cosmos.CreateDocument);

    // From the beginning: the first listener start can trail the data-role
    // assignment, and a write before it would otherwise be skipped.
    yield* Azure.CosmosDB.consumeChangeFeed(
      orders,
      { leases, startFromBeginning: true },
      (documents) =>
        Effect.forEach(documents, (document) =>
          results.put(`cosmos/${String(document.id)}`, JSON.stringify({ batch: documents.length })),
        ).pipe(Effect.asVoid, Effect.orDie),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const id = url.searchParams.get("id") ?? "";
        switch (url.pathname) {
          case "/cosmos/write": {
            const account = yield* accountName;
            const databaseId = yield* databaseName;
            const collectionId = yield* containerName;
            return yield* respond(
              createDocument({
                accountName: account,
                databaseId,
                collectionId,
                document: { id, kind: "order" },
                partitionKey: [id],
              }),
            );
          }
          case "/result": {
            const found = yield* results.get(url.searchParams.get("key") ?? "").pipe(Effect.orDie);
            return found === undefined ? text("missing", 404) : text(found.text());
          }
          default:
            return text("not found", 404);
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.Functions.CosmosDBChangeFeedEventSource,
        Azure.Storage.BlobContainerReadWriteHttp,
      ),
    ),
  ),
) {}
