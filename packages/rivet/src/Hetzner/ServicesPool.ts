import * as Hetzner from "@alchemy.run/hetzner";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  makeServicesLayer,
  servicesEnvironment,
  type ServicesPoolSettings,
} from "../internal/ServicesHost.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes, one Server each.
   * @default 1
   */
  replicas?: number;
  /**
   * Hetzner location of the Servers.
   * @default "nbg1"
   */
  location?: string;
  /**
   * Server type of each node.
   * @default "cx23"
   */
  serverType?: string;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/** Boot one Services node: run the image on Docker, with its environment. */
const userData = (image: string, environment: Record<string, string>) => `#!/bin/bash
set -euo pipefail
until docker info >/dev/null 2>&1; do sleep 2; done
docker rm -f rivet-services >/dev/null 2>&1 || true
docker run -d --name rivet-services --restart always \\
${Object.entries(environment)
  .map(([name, value]) => `  -e ${name}=${shellQuote(value)} \\`)
  .join("\n")}
  ${shellQuote(image)}
`;

/**
 * Run Rivet Services on Hetzner Cloud: the `services` pool on the control
 * plane, and Servers running Rivet's prebuilt Services node on Docker, which
 * hosts Durable Streams and agentOS. A firewall drops every inbound
 * connection: callers reach every stream through the control plane's
 * gateway, with its token. Works with any control plane it can reach.
 *
 * ### Running Rivet Services on Hetzner
 * **Example:** Services next to a Hetzner control plane
 * ```typescript
 * export const Cluster = RivetHetzner.ServerControlPlane("Rivet");
 * export const Services = RivetHetzner.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (id: string, options: ServicesPoolOptions = {}) =>
  makeServicesLayer({
    label: "RivetHetzner.ServicesPool",
    id,
    settings: options,
    expected: "a reachable control plane",
    network: (cluster) => cluster.network ?? { kind: "none" as const },
    nodes: Effect.fn(function* (nodes) {
      const firewall = yield* Hetzner.Firewall(`${id}Firewall`, {});
      const environment = servicesEnvironment(nodes);
      for (let i = 0; i < (options.replicas ?? 1); i++) {
        yield* Hetzner.Server(`${id}Node${i}`, {
          serverType: options.serverType ?? "cx23",
          // Services nodes only dial out, over IPv4.
          enableIpv6: false,
          image: "docker-ce",
          location: options.location ?? "nbg1",
          firewalls: [firewall],
          userData: environment.pipe(
            Output.map((env) => userData(nodes.image, env)),
          ) as unknown as string,
        });
      }
    }),
  });
