import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Db, Site } from "./shared.ts";

/**
 * Effect-native canvas Function. Bundled into one file on the Bun
 * function runtime — no Docker, no registry. Binds the same {@link Db}
 * as {@link Api} via {@link Railway.ConnectPostgres}.
 */
export default class Ping extends Railway.Function<Ping>()(
  "Ping",
  {
    project: Site,
    main: import.meta.url,
    build: { install: ["pg", "drizzle-orm"] },
  },
  Effect.gen(function* () {
    const conn = yield* Railway.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);
    return {
      fetch: db.execute("select 1 as ok").pipe(
        Effect.flatMap(HttpServerResponse.json),
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Railway.ConnectPostgresHttp)),
) {}
