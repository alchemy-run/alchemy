import type * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as D1 from "alchemy/SQL/D1";
import * as Postgres from "alchemy/SQL/Postgres";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { LinkNotFound, type Link } from "./Link.ts";

// #region service
export class Links extends Context.Service<
  Links,
  {
    get(code: string): Effect.Effect<Link, LinkNotFound, Alchemy.RuntimeContext>;
  }
>()("Links") {}
// #endregion service

const linksOver = (sql: SqlClient.SqlClient) => ({
  get: (code: string) =>
    sql<Link>`SELECT * FROM links WHERE code = ${code}`.pipe(
      Effect.orDie,
      Effect.flatMap(([link]) =>
        link ? Effect.succeed(link) : Effect.fail(new LinkNotFound({ code })),
      ),
    ),
});

// #region layer
export const LinksD1 = Layer.effect(
  Links,
  Effect.gen(function* () {
    // construction: the infrastructure this component needs
    const db = yield* Cloudflare.D1.Database("Links", { migrations: "./migrations" });
    const sql = yield* D1.D1(yield* Cloudflare.D1.QueryDatabase(db));

    // runtime: the interface the application uses
    return linksOver(sql);
  }),
).pipe(Layer.provide(Cloudflare.D1.QueryDatabaseBinding));
// #endregion layer

// #region neon
export const LinksNeon = Layer.effect(
  Links,
  Effect.gen(function* () {
    const db = yield* Neon.Project("Links", { migrations: "./migrations" });
    const pool = yield* Cloudflare.Hyperdrive.Connection("Pool", { origin: db.origin });
    const { connectionString } = yield* Cloudflare.Hyperdrive.Connect(pool);
    const sql = yield* Postgres.Postgres({ url: connectionString });

    return linksOver(sql);
  }),
).pipe(Layer.provide(Cloudflare.Hyperdrive.ConnectBinding));
// #endregion neon
