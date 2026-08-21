/**
 * Fly.io Managed Postgres attached to an HTTP Service.
 *
 * Billed (~$38/mo Basic). Live tests skip unless FLY_TEST_MPG=1.
 */
import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Db, PublicIp, Site } from "./src/shared.ts";

export default Alchemy.Stack(
  "FlyPostgres",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const db = yield* Db;
    const ip = yield* PublicIp;
    const api = yield* Api;

    return {
      appName: site.appName,
      appUrl: site.url,
      clusterId: db.clusterId,
      clusterName: db.name,
      region: db.region,
      ip: ip.ip,
      apiUrl: api.url,
    };
  }),
);
