import { fileURLToPath } from "node:url";
import * as Docker from "@alchemy.run/docker";
import type { Stack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { Cluster } from "../Cluster.ts";
import type { PoolHost } from "../Host.ts";
import {
  isImageProgram,
  makePoolLayer,
  RIVETKIT_VERSION,
  type PoolSettings,
} from "../internal/PoolHost.ts";
import type { Providers as RivetProviders } from "../Providers.ts";

export interface SwarmPoolOptions extends PoolSettings {
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
 * `Rivet.Cluster` on a Docker network — `RivetDocker.SwarmControlPlane`.
 *
 * Every Durable Object given the same pool shares its nodes: declare the
 * pool once and provide it to each class.
 *
 * ### Running Durable Objects on Docker
 * **Example:** A pool on the local swarm
 * ```typescript
 * export const Cluster = RivetDocker.SwarmControlPlane("Rivet");
 * export const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(Cluster));
 * ```
 *
 * **Example:** Two nodes
 * ```typescript
 * export const Default = RivetDocker.SwarmPool("Default", { replicas: 2 }).pipe(
 *   Layer.provide(Cluster),
 * );
 * ```
 *
 * @primitive
 */
export const SwarmPool = (
  id: string,
  options: SwarmPoolOptions = {},
): Layer.Layer<PoolHost, never, Cluster | Stack | RivetProviders | Docker.Providers> =>
  makePoolLayer({
    label: "RivetDocker.SwarmPool",
    id,
    settings: options,
    expected: "a Docker network (RivetDocker.SwarmControlPlane)",
    network: (cluster) => (cluster.network?.kind === "docker" ? cluster.network : undefined),
    nodes: ({ network, pool, program, environment }) =>
      isImageProgram(program)
        ? // A Rust program is its own image, built from its staged crate.
          Docker.Image(`${id}NodeImage`, {
            build: { context: program.context, dockerfile: program.dockerfile },
          }).pipe(
            Effect.flatMap((image) =>
              Docker.Service(`${id}Nodes`, {
                image: image.imageRef,
                replicas: options.replicas ?? 1,
                networks: [{ name: network.name }],
                env: pool.env,
                environment,
              }),
            ),
            Effect.asVoid,
          )
        : Docker.Image("RivetNodeImage", {
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
