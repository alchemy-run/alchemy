import * as Azure from "@alchemy.run/azure";
import * as Effect from "effect/Effect";

/**
 * A serverless Cosmos DB for NoSQL account: billed per request unit, and
 * nothing while idle. Serverless accounts provision in about a minute in
 * `centralus` (25+ minutes were seen in `eastus`).
 */
export const Account = Azure.CosmosDB.DatabaseAccount("Account", {
  location: "centralus",
  capabilities: ["EnableServerless"],
});

/** The SQL database that holds every container. */
export const Database = Effect.gen(function* () {
  const account = yield* Account;
  return yield* Azure.CosmosDB.SqlDatabase("Database", { account: account.accountName });
});

const container = (id: string, partitionKey: string) =>
  Effect.gen(function* () {
    const account = yield* Account;
    const database = yield* Database;
    return yield* Azure.CosmosDB.SqlContainer(id, {
      account: account.accountName,
      database: database.databaseName,
      partitionKey: { paths: [partitionKey] },
    });
  });

/** One document per todo, partitioned by its owner. The API reads and writes it. */
export const Todos = container("Todos", "/owner");

/**
 * The latest version of each changed todo, as the worker saw it on the
 * `Todos` change feed. The worker writes it; the API reads it.
 */
export const Changes = container("Changes", "/owner");

/** The change feed's leases (the worker's checkpoints), partitioned by `/id`. */
export const Leases = container("Leases", "/id");

/** A document in the `Todos` container. */
export interface Todo {
  id: string;
  owner: string;
  title: string;
  done: boolean;
}

/** A document in the `Changes` container. */
export interface Change extends Todo {
  /** The `_etag` of the todo version the worker saw. */
  version: string;
  /** When Cosmos DB last wrote that version (`_ts`, seconds since the epoch). */
  changedAt: number;
}

/** The todo fields of a document, without Cosmos DB's system properties. */
export const toTodo = (document: unknown): Todo => {
  const { id, owner, title, done } = document as Todo;
  return { id, owner, title, done };
};
