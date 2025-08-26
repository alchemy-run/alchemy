import type { Context } from "../context.ts";
import { Resource } from "../resource.ts";
import { DockerApi } from "./api.ts";

/**
 * Properties for creating a Docker network
 */
export interface NetworkProps {
  /**
   * Network name
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;

  /**
   * Network driver to use
   * @default "bridge"
   */
  driver?: "bridge" | "host" | "none" | "overlay" | "macvlan" | (string & {});

  /**
   * Enable IPv6 on the network
   * @default false
   */
  enableIPv6?: boolean;

  /**
   * Network-scoped alias for containers
   */
  labels?: Record<string, string>;
}

/**
 * Docker Network resource
 */
export interface Network extends Resource<"docker::Network">, NetworkProps {
  /**
   * Network ID
   */
  id: string;

  /**
   * Network name
   */
  name: string;

  /**
   * Time when the network was created
   */
  createdAt: number;
}

/**
 * Create and manage a Docker Network
 *
 * @see https://docs.docker.com/engine/network/
 *
 * @example
 * // Create a simple bridge network
 * const appNetwork = await Network("app-network", {
 *   name: "app-network"
 * });
 *
 * @example
 * // Create a custom network with driver
 * const overlayNetwork = await Network("overlay-network", {
 *   name: "overlay-network",
 *   driver: "overlay",
 *   enableIPv6: true,
 *   labels: {
 *     "com.example.description": "Network for application services"
 *   }
 * });
 */
export const Network = Resource(
  "docker::Network",
  async function (
    this: Context<Network>,
    id: string,
    props: NetworkProps,
  ): Promise<Network> {
    // Initialize Docker API client
    const api = new DockerApi();

    const networkName =
      props.name ?? this.output?.name ?? this.scope.createPhysicalName(id);

    if (this.phase === "update" && this.output.name !== networkName) {
      this.replace();
    }

    // Handle delete phase
    if (this.phase === "delete") {
      if (this.output?.id) {
        // Remove network
        await api.removeNetwork(this.output.id);
      }

      // Return destroyed state
      return this.destroy();
    } else {
      // Create the network
      props.driver = props.driver || "bridge";
      const networkId = await api.createNetwork(networkName, props.driver);

      // Return the resource using this() to construct output
      return this({
        ...props,
        id: networkId,
        name: networkName,
        createdAt: Date.now(),
      });
    }
  },
);
