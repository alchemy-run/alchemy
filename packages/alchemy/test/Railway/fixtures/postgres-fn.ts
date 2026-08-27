import * as Drizzle from "@/Drizzle/Postgres.ts";
import { ConnectPostgres } from "@/Railway/ConnectPostgres.ts";
import { ConnectPostgresHttp } from "@/Railway/ConnectPostgresHttp.ts";
import { Function } from "@/Railway/Function.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Db, Site } from "./postgres-shared.ts";

export { Db, Site };

/**
 * Canvas Function that binds {@link Db} via {@link ConnectPostgres} and
 * answers SELECT 1. Kept small for Railway's 96KB encoded start command.
 */
export default class PostgresFn extends Function<PostgresFn>()(
  "PostgresFn",
  {
    project: Site,
    main: import.meta.url,
    build: { install: ["pg", "drizzle-orm"] },
  },
  Effect.gen(function* () {
    const conn = yield* ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);
    return {
      fetch: db.execute("select 1 as ok", "objects").pipe(
        Effect.flatMap((rows) => HttpServerResponse.json({ rows })),
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(ConnectPostgresHttp)),
) {}
