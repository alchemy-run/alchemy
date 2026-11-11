import * as DigitalOcean from "@alchemy.run/digitalocean";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/api.ts";
import { Db } from "./src/resources.ts";

export default Alchemy.Stack(
  "DigitalOceanApp",
  {
    providers: DigitalOcean.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const db = yield* Db;
    // Migrations run on every deploy, before the API's new version.
    yield* DigitalOcean.Databases.Database("App", {
      clusterId: db.clusterId,
      migrations: "./migrations",
    });
    const api = yield* Api;
    return { url: api.url };
  }),
);
