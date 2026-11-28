/**
 * The front of the hosting suite on Rivet: a Docker service on the control
 * plane's network that reaches the desk's and the Helper's objects through
 * the gateway.
 */
import * as Docker from "@alchemy.run/docker";
import * as Rivet from "@alchemy.run/rivet";
import * as Effect from "effect/Effect";
import { app } from "../desk.ts";
import { HostedControlPlane } from "./cluster.ts";
import HostedRivetLive from "./live.ts";

export default class HostedRivetFront extends Docker.Service<HostedRivetFront>()(
  "RivetHostedFront",
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
  }).pipe(Effect.provide(HostedControlPlane)),
  Effect.gen(function* () {
    return { fetch: yield* app };
  }).pipe(Effect.provide(HostedRivetLive)),
) {}
