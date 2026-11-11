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

/** Queries the bound cluster with the connection string Connect hands it. */
export default class ConnectApp extends DigitalOcean.App<ConnectApp>()(
  "ConnectApp",
  { main: import.meta.url, registry: TestRegistry, region: "nyc" },
  Effect.gen(function* () {
    const conn = yield* DigitalOcean.Databases.Connect(yield* Db);
    return {
      fetch: Effect.gen(function* () {
        const uri = yield* conn.connectionString;
        const value = yield* Effect.tryPromise(async () => {
          const client = new pg.Client({
            connectionString: Redacted.value(uri).replace(/\?.*$/, ""),
            ssl: { rejectUnauthorized: false },
          });
          await client.connect();
          try {
            const result = await client.query("SELECT 41 + 1 AS answer");
            return result.rows[0].answer as number;
          } finally {
            await client.end();
          }
        });
        return yield* HttpServerResponse.json({ answer: value });
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(DigitalOcean.Databases.ConnectHttp)),
) {}
