import * as Cloudflare from "alchemy/Cloudflare";
import * as Planetscale from "alchemy/Planetscale";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Database } from "./Database.ts";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Planetscale.PostgresDatabase("Db", { clusterSize: "PS_10", arch: "arm" });
    const db = yield* Planetscale.PostgresRole("Db", { database, inheritedRoles: ["postgres"] });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Layer.effect(Database, SqlClient.SqlClient).pipe(
      Layer.provide(Postgres.PostgresLayer({ url: connection.connectionString })),
    );
  }),
).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
// #endregion show
