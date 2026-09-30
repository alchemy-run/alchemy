import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// The Database module built up line by line (Db.ts is the finished file).
// #region show
/** The Database module's interface: a SQL client. */
export class Database extends Context.Service<Database, SqlClient.SqlClient>()("Database") {}

export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Neon.Project("Db", { migrations: "./migrations" });
    // #region pool
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    // #endregion pool
    // #region connect
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    // #endregion connect
    // #region ret
    return Layer.effect(Database, SqlClient.SqlClient).pipe(
      Layer.provide(Postgres.PostgresLayer({ url: connection.connectionString })),
    );
    // #endregion ret
  }),
)/*hide*/.pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding))/*end*/;
// #endregion show
