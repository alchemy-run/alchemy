import * as Fly from "@/Fly";
import * as SQL from "@/SQL/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const POSTGRES_PORT = 3000;

export const MpgSite = Fly.App("MpgSite", {
  enableSubdomains: true,
});

export const Db = Fly.Postgres("Db", {
  region: "iad",
  plan: "basic",
  volumeSizeGb: 10,
});

export const MpgIp = Fly.IpAssignment("Shared", {
  app: MpgSite,
  type: "shared_v4",
});

/**
 * HTTP Service that binds Managed Postgres via {@link Fly.ConnectPostgres}
 * and answers SELECT 1. Never returns the connection string.
 */
export default class PostgresApi extends Fly.Service<PostgresApi>()(
  "PostgresApi",
  {
    app: MpgSite,
    main: import.meta.url,
    region: "iad",
    port: POSTGRES_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const conn = yield* Fly.ConnectPostgres(Db);
    const sql = yield* SQL.Postgres({ url: conn.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        const rows = (yield* sql`SELECT 1 AS ok`) as ReadonlyArray<{
          ok: number;
        }>;
        const ok = rows[0]?.ok === 1;
        if (path === "/health" || path === "/") {
          return yield* HttpServerResponse.json({ ok });
        }
        return yield* HttpServerResponse.json({ ok }, { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Fly.ConnectPostgresHttp)),
) {}
