import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as D1 from "alchemy/SQL/D1";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** SQLite on Cloudflare D1. */
export const D1Storage = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.Database("Db", { migrations: "./migrations" });
    return D1.D1Layer(yield* Cloudflare.D1.QueryDatabase(db));
  }),
).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));

// #region neon
export const NeonStorage = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Neon.Project("Postgres", { migrations: "./migrations" });
    // #region pool
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", {
      origin: db.origin,
      // #region dev
      dev: db.pooledOrigin,
      // #endregion dev
      // #region caching
      caching: { disabled: true },
      // #endregion caching
    });
    // #endregion pool
    // #region connect
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    // #endregion connect
    // #region sql
    return Postgres.PostgresLayer({ url: connection.connectionString });
    // #endregion sql
  }),
)
  // #region bind
  .pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
  // #endregion bind
// #endregion neon
