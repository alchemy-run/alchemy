/**
 * The front of the Domain conformance suite: a Docker service on the
 * database's network that runs the model's Api side and reaches its
 * entities through the pool's gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { DomainDatabase } from "./cluster.ts";
import { ConformanceClusterLive } from "./live.ts";
import { TickersClusterLive, withTickRoute } from "./tickers.ts";

export default class DomainFront extends Docker.Service<DomainFront>()(
  "ClusterDomainFront",
  Effect.gen(function* () {
    const database = yield* Cluster.Database.Database;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ internal: 3000 }],
      networks: database.network?.kind === "docker" ? [{ name: database.network.name }] : [],
    };
  }).pipe(Effect.provide(DomainDatabase)),
  Effect.gen(function* () {
    return { fetch: yield* withTickRoute(yield* app) };
  }).pipe(Effect.provide(Layer.merge(TickersClusterLive, ConformanceClusterLive))),
) {}
