/**
 * What every services pool Layer shares, whatever runs its nodes: the
 * `services` pool on the control plane, the environment Rivet's Services
 * node reads, and what callers need. A host only declares the service that
 * runs the image.
 *
 * @internal
 */
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Cluster, type ClusterShape } from "../Cluster.ts";
import { Pool } from "../Pool.ts";
import type { Providers } from "../Providers.ts";
import { Services, SERVICES_IMAGE, SERVICES_POOL } from "../Services.ts";
import { ClusterNetworkMismatch } from "./PoolHost.ts";

export interface ServicesPoolSettings {
  /**
   * Rivet Services image.
   * @default "rivetdev/services:0.2.5"
   */
  image?: string;
}

/** What a host needs to declare the service that runs Rivet Services. */
export interface ServicesNodes<Network> {
  readonly cluster: ClusterShape;
  readonly network: Network;
  readonly image: string;
  /** Environment every Services node needs. */
  readonly environment: {
    readonly RIVET_ENDPOINT: Input<string>;
    readonly RIVET_TOKEN: ClusterShape["token"];
    readonly RIVET_NAMESPACE: ClusterShape["namespace"];
    readonly RIVET_POOL: Input<string>;
    readonly HOST: string;
  };
}

/**
 * A services pool Layer: `network` narrows the cluster's network to the
 * one this host can join, `nodes` declares the service that runs the image.
 */
export const makeServicesLayer = <Network, Req>(options: {
  readonly label: string;
  readonly id: string;
  readonly settings: ServicesPoolSettings;
  readonly network: (cluster: ClusterShape) => Network | undefined;
  readonly expected: string;
  readonly nodes: (nodes: ServicesNodes<Network>) => Effect.Effect<void, never, Req>;
}): Layer.Layer<Services, never, Cluster | Providers | Req> =>
  Layer.effect(
    Services,
    Effect.gen(function* () {
      const cluster = yield* Cluster;
      if (globalThis.__ALCHEMY_RUNTIME__) {
        // Callers read their endpoint and token from their own environment.
        return { endpoint: "", token: Redacted.make(""), namespace: "" };
      }
      const network = options.network(cluster);
      if (network === undefined) {
        return yield* Effect.die(
          new ClusterNetworkMismatch({
            message: `${options.label} runs nodes on ${options.expected}, and its cluster is not on one.`,
          }),
        );
      }
      const pool = yield* Pool(`${options.id}Pool`, {
        endpoint: cluster.endpoint,
        token: cluster.token,
        namespace: cluster.namespace,
        name: SERVICES_POOL,
      });
      yield* options.nodes({
        cluster,
        network,
        image: options.settings.image ?? SERVICES_IMAGE,
        environment: {
          // A private address only works inside the control plane's network.
          RIVET_ENDPOINT:
            network === cluster.network
              ? (cluster.nodeEndpoint ?? cluster.endpoint)
              : cluster.endpoint,
          RIVET_TOKEN: cluster.token,
          RIVET_NAMESPACE: cluster.namespace,
          // Ordered after the pool: nodes join it as they start.
          RIVET_POOL: pool.name,
          HOST: "0.0.0.0",
        },
      });
      return {
        endpoint: cluster.clientEndpoint ?? cluster.endpoint,
        token: cluster.token,
        namespace: cluster.namespace,
      };
    }),
  );

const output = <T>(value: Input<T>): Output.Output<T> =>
  (Output.isOutput(value) ? value : Output.literal(value)) as Output.Output<T>;

/** The Services node's environment as plain values, for hosts that take a record. */
export const servicesEnvironment = ({ environment }: ServicesNodes<unknown>) =>
  Output.all(
    output(environment.RIVET_ENDPOINT),
    output(environment.RIVET_TOKEN),
    output(environment.RIVET_NAMESPACE),
    output(environment.RIVET_POOL),
  ).pipe(
    Output.map(([endpoint, token, namespace, pool]) => ({
      RIVET_ENDPOINT: endpoint,
      RIVET_TOKEN: Redacted.value(token),
      RIVET_NAMESPACE: namespace,
      RIVET_POOL: pool,
      HOST: environment.HOST,
    })),
  );
