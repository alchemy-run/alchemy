import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Database } from "./Database.ts";

// #region show
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const database = yield* Cloudflare.D1.Database("Db");
    const db = yield* Cloudflare.D1.QueryDatabase(database);
    return Layer.effect(Database, SqlClient.SqlClient).pipe(
      Layer.provide(SQL.D1Layer(db)),
    );
  }),
).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));
// #endregion show
