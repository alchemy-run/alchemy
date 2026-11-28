/**
 * The front of the Domain conformance suite at the model's next version
 * (see `rebuild` in the conformance suite): the same service as
 * `domain-front.ts`, deployed over it.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { app } from "../../Domain/conformance/app.ts";
import { DomainControlPlane } from "./domain-cluster.ts";
import ConformanceRivetLiveV1 from "./domain-live-v1.ts";

export default class DomainFrontV1 extends Docker.Service<DomainFrontV1>()(
  "RivetDomainFront",
  Effect.gen(function* () {
    const cluster = yield* Rivet.Cluster;
    return {
      main: import.meta.url,
      port: 3000,
      // On a free port: the suite reads it from `ports` after the deploy.
      ports: [{ internal: 3000 }],
      networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
      // Only the nodes load RivetKit; the front reaches actors over HTTP.
      build: { input: { external: ["rivetkit", /^rivetkit\//, /^@rivetkit\//] } },
    };
  }).pipe(Effect.provide(DomainControlPlane)),
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(ConformanceRivetLiveV1)),
) {}
