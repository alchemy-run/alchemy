import * as Docker from "@alchemy.run/docker";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Cluster } from "../Cluster.ts";
import { makeServicesLayer, type ServicesPoolSettings } from "../internal/ServicesHost.ts";
import type { Providers as RivetProviders } from "../Providers.ts";
import type { Services } from "../Services.ts";

export interface ServicesPoolOptions extends ServicesPoolSettings {
  /**
   * Number of Services nodes.
   * @default 1
   */
  replicas?: number;
}

/**
 * Run Rivet Services on a Docker swarm: the `services` pool on the control
 * plane, and a swarm service running Rivet's prebuilt Services node, which
 * hosts Durable Streams and agentOS. Its tasks join the control plane's
 * overlay network and publish no ports: callers reach every stream through
 * the control plane's gateway, with its token. Requires a `Rivet.Cluster`
 * on a Docker network — `RivetDocker.SwarmControlPlane`.
 *
 * ### Running Rivet Services on Docker
 * **Example:** Services on the local swarm
 * ```typescript
 * export const Cluster = RivetDocker.SwarmControlPlane("Rivet");
 * export const Services = RivetDocker.ServicesPool("Services").pipe(Layer.provide(Cluster));
 * ```
 *
 * @primitive
 */
export const ServicesPool = (
  id: string,
  options: ServicesPoolOptions = {},
): Layer.Layer<Services, never, Cluster | RivetProviders | Docker.Providers> =>
  makeServicesLayer({
    label: "RivetDocker.ServicesPool",
    id,
    settings: options,
    expected: "a Docker network (RivetDocker.SwarmControlPlane)",
    network: (cluster) => (cluster.network?.kind === "docker" ? cluster.network : undefined),
    nodes: ({ network, image, environment }) =>
      Docker.Service(`${id}Nodes`, {
        image,
        replicas: options.replicas ?? 1,
        networks: [{ name: network.name }],
        environment,
      }).pipe(Effect.asVoid),
  });
