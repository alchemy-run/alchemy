import * as Docker from "@alchemy.run/docker";
/** The Docker suite's front: a Docker service on the database's network. */
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { frontApp } from "../app.ts";
import { Database, FRONT_PORT } from "./cluster.ts";
import { Tally } from "./tally.ts";

export default class Front extends Docker.Service<Front>()(
  "ClusterFront",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: FRONT_PORT, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(Database)),
  frontApp(Tally),
) {}
