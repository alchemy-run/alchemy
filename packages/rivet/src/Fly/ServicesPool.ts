import * as Fly from "@alchemy.run/fly";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  secretServicesEnvironment,
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
 * can reach. The control plane's token reaches the Machines as a secret of
 * the pool's App, never in their config.
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
    // The nodes join no network of the control plane's, so they connect to its
    // public endpoint, never a private address they can't reach.
    network: () => ({ kind: "none" as const }),
    nodes: Effect.fn(function* (nodes) {
      const app = yield* Fly.App(`${id}App`, {});
      // Fly gives every App secret to the App's Machines as env: the token
      // stays out of the Machine config.
      const token = yield* Fly.Secret(`${id}Token`, {
        app,
        name: "RIVET_TOKEN",
        value: nodes.environment.RIVET_TOKEN,
      });
      yield* Fly.Machine(`${id}Nodes`, {
        app,
        image: nodes.image,
        region: options.region ?? "iad",
        count: options.replicas ?? 1,
        guest: options.guest ?? { cpus: 1, memoryMb: 2048 },
        env: secretServicesEnvironment(nodes).pipe(Output.map(({ RIVET_TOKEN: _, ...env }) => env)),
        // Machines start once they see the token, and restart with a new one.
        minSecretsVersion: token.version,
        restart: { policy: "always" },
        // Services nodes only dial out: nothing listens for the proxy.
        services: [],
      });
    }),
  });
