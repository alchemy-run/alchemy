import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The Database module built up line by line (Db.ts is the finished file).
// #region show
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
    return Postgres.PostgresLayer({ url: connection.connectionString });
    // #endregion ret
  }),
)/*hide*/.pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding))/*end*/;
// #endregion show
