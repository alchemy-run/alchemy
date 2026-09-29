import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Postgres from "alchemy/SQL/Postgres";
import { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// #region show
export const Database = Layer.unwrap(
  Effect.gen(function* () {
    // #region stage
    const { stage } = yield* Stack;
    // #endregion stage
    // #region db
    const db = stage.startsWith("pr-")
      ? yield* Neon.Branch("Db", {
          project: yield* Neon.Project.ref("Db", { stage: "staging" }),
        })
      : yield* Neon.Project("Db", { migrations: "./migrations" });
    // #endregion db
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const connection = yield* Cloudflare.Hyperdrive.Connect(pool);
    return Postgres.PostgresLayer({ url: connection.connectionString });
  }),
).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
// #endregion show
