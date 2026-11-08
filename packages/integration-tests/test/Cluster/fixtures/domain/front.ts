/**
 * The front of the Domain conformance suite: a Docker service on the
 * database's network that runs the model's Api side and reaches its
 * entities through the pool's gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { app } from "../../../Domain/conformance/app.ts";
import { DOMAIN_FRONT_PORT, DomainDatabase } from "./cluster.ts";
import { ConformanceClusterLive } from "./live.ts";

export default class DomainFront extends Docker.Service<DomainFront>()(
  "ClusterDomainFront",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: DOMAIN_FRONT_PORT, internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(DomainDatabase)),
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(ConformanceClusterLive)),
) {}
