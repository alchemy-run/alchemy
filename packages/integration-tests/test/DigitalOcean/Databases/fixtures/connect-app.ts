import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Redacted from "effect/Redacted";
import pg from "pg";
import { TestRegistry } from "../../fixtures/app/shared.ts";

export const Db = DigitalOcean.Databases.Cluster("Db", {
  engine: "pg",
  size: "db-s-1vcpu-1gb",
  region: "nyc3",
});

export const AppDb = Effect.gen(function* () {
  const db = yield* Db;
  return yield* DigitalOcean.Databases.Database("App", { clusterId: db.clusterId });
});

/**
 * Queries the bound database with the connection string Connect hands it,
 * verifying the server against the cluster's CA.
 */
export default class ConnectApp extends DigitalOcean.App<ConnectApp>()(
  "ConnectApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const conn = yield* DigitalOcean.Databases.Connect(AppDb);
    return {
      fetch: Effect.gen(function* () {
        const uri = yield* conn.connectionString;
        const ca = yield* conn.caCertificate;
        const row = yield* Effect.tryPromise(async () => {
          const client = new pg.Client({
            connectionString: Redacted.value(uri).replace(/[?&]sslmode=[^&]*/, ""),
            ssl: { ca },
          });
          await client.connect();
          try {
            const result = await client.query(
              "SELECT 41 + 1 AS answer, current_database() AS database",
            );
            return result.rows[0] as { answer: number; database: string };
          } finally {
            await client.end();
          }
        });
        return yield* HttpServerResponse.json(row);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Databases.ConnectHttp)),
) {}
