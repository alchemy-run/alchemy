import { fileURLToPath } from "node:url";
import * as Docker from "@alchemy.run/docker";
import type { Provider } from "alchemy/Provider";
import type { Self } from "alchemy/Self";
import type { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Cluster } from "../Cluster.ts";
import { makePoolLayer, RIVETKIT_VERSION, type PoolSettings } from "../internal/PoolHost.ts";
import type { Pool as RivetPool } from "../Pool.ts";

export interface PoolOptions extends PoolSettings {
  /**
   * Number of nodes.
   * @default 1
   */
  replicas?: number;
}

/**
 * Run a pool's nodes on a Docker swarm: a pool on the control plane, and a
 * swarm service whose tasks host every `Rivet.DurableObject` given this
 * pool and join the control plane's overlay network. Nodes only connect
 * out to the control plane, so the service publishes no ports. Requires a
 * `Rivet.Cluster` on a Docker network — `RivetDocker.ControlPlane`.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Docker
 * **Example:** A pool on the local swarm
 * ```typescript
 * export const Cluster = RivetDocker.ControlPlane("Rivet");
 * export const Default = RivetDocker.Pool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** Two nodes
 * ```typescript
 * export const Default = RivetDocker.Pool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const Pool = (
  id: string,
  options: PoolOptions = {},
): Layer.Layer<never, never, Cluster | Self | Stack | Provider<RivetPool> | Docker.Providers> =>
  makePoolLayer({
    label: "RivetDocker.Pool",
    id,
    settings: options,
    expected: "a Docker network (RivetDocker.ControlPlane)",
    network: (cluster) => (cluster.network?.kind === "docker" ? cluster.network : undefined),
    nodes: ({ network, pool, program, environment }) =>
      Docker.Image("RivetNodeImage", {
        // One node image per stack; every pool builds FROM it.
        build: {
          context: fileURLToPath(new URL("../../images/node", import.meta.url)),
          args: { RIVETKIT_VERSION },
        },
      }).pipe(
        Effect.flatMap((image) =>
          // Every class the pool hosts is bundled into its node image.
          Docker.Service(`${id}Nodes`, {
            ...program,
            image: image.imageRef,
            replicas: options.replicas ?? 1,
            networks: [{ name: network.name }],
            env: pool.env,
            environment,
          }),
        ),
        Effect.asVoid,
      ),
  });
