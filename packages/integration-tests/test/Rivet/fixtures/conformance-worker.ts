/**
 * The conformance worker, deployed as a **Rivet** Worker on a local Docker
 * swarm against a Docker control plane.
 */
import * as Rivet from "@alchemy.run/rivet";
import * as RivetDocker from "@alchemy.run/rivet/Docker";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { conformanceFetch } from "../../Cloudflare/Workers/conformance/routes.ts";
import { Counter, CounterLive } from "./counter.ts";

export const CONTROL_PLANE_PORT = 16440;
export const WORKER_PORT = 18440;

export const Cluster = RivetDocker.ControlPlane("Rivet", { port: CONTROL_PLANE_PORT });
export const Host = RivetDocker.Service({ port: WORKER_PORT }).pipe(Layer.provide(Cluster));

export default class ConformanceWorker extends Rivet.Worker<ConformanceWorker>()(
  "RivetConformance",
  { main: import.meta.url },
  Effect.gen(function* () {
    const counters = yield* Counter;
    return { fetch: conformanceFetch(counters) };
  }).pipe(Effect.provide(Layer.mergeAll(CounterLive, Host))),
) {}
