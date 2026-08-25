import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Neon from "@/Neon/index.ts";
import * as SQL from "@/SQL/Postgres.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Name of the Hyperdrive config `Ref.local.test.ts` creates out-of-band
 * before deploying this fixture.
 */
export const REF_LOCAL_CONFIG_NAME = "alchemy-hyperdrive-ref-local-test";

/**
 * Read-only reference with a `dev` origin override: the Cloudflare API
 * never returns the origin credentials of an existing config, so local dev
 * can only passthrough when the ref declares where to connect. The dev
 * origin is the same real Neon Postgres the referenced config fronts.
 */
export const LocalHyperdriveRef = Effect.gen(function* () {
  const project = yield* Neon.Project("HyperdriveRefLocalProject");
  return yield* Cloudflare.Hyperdrive.Ref("HyperdriveRefLocal", {
    name: REF_LOCAL_CONFIG_NAME,
    dev: project.origin,
  });
});

/**
 * Effect-native Worker binding the referenced Hyperdrive config. `/query`
 * runs a trivial SQL statement through `SQL.Postgres` over the binding's
 * connection string — under `alchemy dev` that string points straight at
 * the `dev` origin (the local runtime's origin passthrough).
 */
export default class HyperdriveRefLocalWorker extends Cloudflare.Worker<HyperdriveRefLocalWorker>()(
  "HyperdriveRefLocalWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(LocalHyperdriveRef);
    const sql = yield* SQL.Postgres({ url: hd.connectionString });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        if (url.pathname === "/query") {
          const rows = (yield* sql`
            SELECT 1 + 1 AS sum, current_database() AS db
          `) as ReadonlyArray<{ sum: number; db: string }>;
          const host = yield* hd.host;
          return yield* HttpServerResponse.json({ row: rows[0], host });
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ error: String(cause) }, { status: 500 }),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}
