import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  SpacetimeDBClient,
  type SqlStatementResult,
  type SpacetimeDBClient as ClientService,
} from "./Client.ts";
import type { ConnectClient } from "./Connect.ts";

/**
 * Effect-native HTTP management client for a SpacetimeDB database.
 *
 * Prefer the WebSocket SDK ({@link makeConnectionLayer}) for real-time
 * subscriptions. Use this for one-shot reducer calls, SQL, or logs — e.g.
 * from a Cloudflare Worker or deploy-time Action.
 *
 * ```typescript
 * const db = yield* DatabaseHttp;
 * yield* db.call("add_todo", [{ text: "ship it" }]);
 * const rows = yield* db.sql("SELECT * FROM todo");
 * ```
 */
export interface DatabaseHttpService {
  readonly databaseName: string;
  readonly host: string;
  readonly call: (
    reducer: string,
    args?: ReadonlyArray<unknown>,
  ) => ReturnType<ClientService["call"]>;
  readonly sql: (query: string) => ReturnType<ClientService["sql"]>;
  readonly logs: (options?: {
    readonly numLines?: number;
  }) => ReturnType<ClientService["getLogs"]>;
}

export class DatabaseHttp extends Context.Service<
  DatabaseHttp,
  DatabaseHttpService
>()("SpacetimeDB::DatabaseHttp") {}

/**
 * Build a {@link DatabaseHttp} layer from explicit coordinates.
 * Requires ambient {@link SpacetimeDBClient} (credentials + HttpClient).
 */
export const makeDatabaseHttpLayer = (options: {
  readonly databaseName: string;
}) =>
  Layer.effect(
    DatabaseHttp,
    Effect.gen(function* () {
      const client = yield* SpacetimeDBClient;
      return makeService(client, options.databaseName);
    }),
  );

/**
 * Build a {@link DatabaseHttp} layer from a {@link ConnectClient}.
 */
export const makeDatabaseHttpLayerFromConnect = (connect: ConnectClient) =>
  Layer.effect(
    DatabaseHttp,
    Effect.gen(function* () {
      const client = yield* SpacetimeDBClient;
      const databaseName = yield* connect.databaseName;
      return makeService(client, databaseName);
    }),
  );

const makeService = (
  client: ClientService,
  databaseName: string,
): DatabaseHttpService => ({
  databaseName,
  host: client.credentials.host,
  call: (reducer, args = []) => client.call(databaseName, reducer, args),
  sql: (query) => client.sql(databaseName, query),
  logs: (options) => client.getLogs(databaseName, options),
});
