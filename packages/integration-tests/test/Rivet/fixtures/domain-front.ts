/**
 * The front of the Domain conformance suite: a Docker service on the
 * control plane's network that runs the model's Api side and reaches its
 * objects through the gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as DomainRivet from "@alchemy.run/rivet/Domain";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { app } from "../../Domain/conformance/app.ts";
import { ConformanceLive } from "../../Domain/conformance/model.ts";
import { DOMAIN_FRONT_PORT, DomainControlPlane } from "./domain-cluster.ts";
import DomainObjects from "./domain-objects.ts";

export default class DomainFront extends Docker.Service<DomainFront>()(
  "RivetDomainFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      ports: [{ external: DOMAIN_FRONT_PORT, internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(DomainControlPlane)),
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(ConformanceLive.pipe(Layer.provide(DomainRivet.layer(DomainObjects))))),
) {}
