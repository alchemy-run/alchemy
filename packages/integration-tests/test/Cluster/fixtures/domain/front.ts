/**
 * The front of the Domain conformance suite: a Docker service on the
 * database's network that runs the models' Api side and reaches their
 * entities through the pool's gateway: the conformance model, and the
 * contract model under `/contract`.
 */
import * as Docker from "@alchemy.run/docker";
import * as Cluster from "@alchemy.run/effect-cluster";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { app } from "../../../Domain/conformance/app.ts";
import { DOMAIN_FRONT_PORT, DomainDatabase } from "./cluster.ts";
import { contractApp } from "./contract-app.ts";
import { ContractClusterLive } from "./contract-live.ts";
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
    const conformance = yield* app;
    const contract = yield* contractApp;
    return {
      fetch: Effect.flatMap(HttpServerRequest, (request) =>
        new URL(request.url, "http://front").pathname.startsWith("/contract/")
          ? contract
          : conformance,
      ),
    };
  }).pipe(Effect.provide(Layer.merge(ConformanceClusterLive, ContractClusterLive))),
) {}
