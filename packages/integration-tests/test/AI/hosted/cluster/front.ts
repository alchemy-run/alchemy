/**
 * The front of the hosting suite on Effect Cluster: a Docker service on the
 * database's network that reaches the desk's and the Helper's entities
 * through the pool's gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { app } from "../desk.ts";
import { HostedDatabase } from "./cluster.ts";
import HostedClusterLive from "./live.ts";

export default class HostedClusterFront extends Docker.Service<HostedClusterFront>()(
  "ClusterHostedFront",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(HostedDatabase)),
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(HostedClusterLive)),
) {}
