/**
 * The front of the Domain conformance suite at the model's next version
 * (see `rebuild` in the conformance suite): the same service as
 * `front.ts`, deployed over it.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { DomainDatabase } from "./cluster.ts";
import ConformanceClusterLiveV1 from "./live-v1.ts";
import TickersClusterLive, { withTickRoute } from "./tickers.ts";

export default class DomainFrontV1 extends Docker.Service<DomainFrontV1>()(
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
  }).pipe(Effect.provide(Layer.merge(TickersClusterLive, ConformanceClusterLiveV1))),
) {}
