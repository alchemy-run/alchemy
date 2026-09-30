import * as AWS from "alchemy/AWS";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Database } from "./Database.ts";
import { Private } from "./Network.ts";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* AWS.RDS.Aurora("Db", yield* Private);
    const db = yield* AWS.RDS.Connect(database.cluster, { secret: database.secret, database: "chat" });
    return Layer.effect(Database, SqlClient.SqlClient).pipe(
      Layer.provide(Postgres.PostgresLayer({ url: Effect.map(db, (info) => info.url) })),
    );
  }),
).pipe(Layer.provide(AWS.RDS.ConnectHttp));
// #endregion show
