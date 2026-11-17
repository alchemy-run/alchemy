import * as Fly from "@alchemy.run/fly";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes, one Machine each.
   * @default 1
   */
  replicas?: number;
  /**
   * Fly region of the Machines.
   * @default "iad"
   */
  region?: string;
  /**
   * CPUs and memory of each Machine.
   * @default { cpus: 1, memoryMb: 2048 }
   */
  guest?: { cpus: number; memoryMb: number };
}

/**
 * Run Rivet Services on Fly Machines: the `services` pool on the control
 * plane, and Machines running Rivet's prebuilt Services node, which hosts
 * Durable Streams and agentOS. The Machines take no traffic from Fly's
 * proxy and only connect out: callers reach every stream through the
 * control plane's gateway, with its token. Works with any control plane it
 * can reach.
 *
 * ### Running Rivet Services on Fly
 * **Example:** Services next to a Fly control plane
 * ```typescript
 * export const Cluster = RivetFly.MachineControlPlane("Rivet");
 * export const Services = RivetFly.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetFly.ServicesPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: Effect.fn(function* (nodes) {
      const app = yield* Fly.App(`${id}App`, {});
      yield* Fly.Machine(`${id}Nodes`, {
        app,
        image: nodes.image,
        region: options.region ?? "iad",
        count: options.replicas ?? 1,
        guest: options.guest ?? { cpus: 1, memoryMb: 2048 },
        env: servicesEnvironment(nodes),
        restart: { policy: "always" },
        // Services nodes only dial out: nothing listens for the proxy.
        services: [],
      });
    }),
  });
