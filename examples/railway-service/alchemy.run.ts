/**
 * A Railway project that exercises the full module-scope graph:
 *
 * - `Site` — parent Project (`src/shared.ts`)
 * - `Db` — Postgres in that Project
 * - `Api` — HTTP Service that binds Postgres via `Railway.ConnectPostgres`
 *   and queries with `Drizzle.Postgres` (`src/api.ts`)
 *
 * Effect-native images are pushed to `RAILWAY_REGISTRY` (GHCR / Docker
 * Hub). Railway has no private registry of its own.
 */
import * as Alchemy from "alchemy";
import * as Railway from "alchemy/Railway";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Db, Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "RailwayService",
  {
    providers: Railway.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const db = yield* Db;
    const api = yield* Api;

    return {
      projectId: site.projectId,
      projectName: site.name,
      postgresServiceId: db.serviceId,
      postgresName: db.name,
      apiServiceId: api.serviceId,
      apiName: api.name,
      apiUrl: api.url,
    };
  }),
);
