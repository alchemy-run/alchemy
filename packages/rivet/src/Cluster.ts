import type { Input } from "alchemy/Input";
import type { Provider } from "alchemy/Provider";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { Namespace } from "./Namespace.ts";

/**
 * The private network a node must join to reach {@link ClusterShape.nodeEndpoint}.
 * A host Layer matches on `kind` and refuses a network it cannot join.
 */
export type ClusterNetwork =
  | {
      /** A Docker network; the node's container joins it by name. */
      readonly kind: "docker";
      readonly name: Input<string>;
    }
  | {
      /** An AWS VPC; nodes run in its subnets with its node security group. */
      readonly kind: "aws";
      readonly vpcId: Input<string>;
      /** Subnets with a route to the internet, for nodes that need no NAT. */
      readonly subnetIds: ReadonlyArray<Input<string>>;
      /** The security group nodes run with. */
      readonly securityGroupId: Input<string>;
    };

/** What pools and clients need to reach a Rivet control plane. */
export interface ClusterShape {
  /**
   * The control plane's API URL, used while deploying (pools, namespaces)
   * and by nodes unless {@link nodeEndpoint} is set.
   */
  readonly endpoint: Input<string>;
  /**
   * The URL runtimes connect to — nodes and `Rivet.Client` callers — when it
   * differs from {@link endpoint}: a private address inside {@link network}.
   */
  readonly nodeEndpoint?: Input<string> | undefined;
  /** The network nodes must join to reach {@link nodeEndpoint}. */
  readonly network?: ClusterNetwork | undefined;
  /** The control plane's admin token. */
  readonly token: Input<Redacted.Redacted<string>>;
  /** The namespace this app's pools and actors live in. */
  readonly namespace: Input<string>;
}

/**
 * The Rivet control plane a pool's nodes join and `Rivet.Client` calls.
 * Provided by a control plane constructor (`Rivet.ControlPlane`,
 * `RivetDocker.ControlPlane`, …) and required by every pool Layer.
 */
export class Cluster extends Context.Service<Cluster, ClusterShape>()("Rivet.Cluster") {}

export interface ControlPlaneProps {
  /** The control plane's API URL. */
  endpoint: string;
  /** The control plane's admin token (`auth.admin_token`). */
  token: Redacted.Redacted<string> | Config.Config<Redacted.Redacted<string>>;
  /**
   * An existing namespace to use. Omit it to create a namespace for this
   * stage.
   */
  namespace?: string;
}

/**
 * A Rivet control plane that already runs elsewhere — Rivet Cloud, or one
 * you operate — as a `Rivet.Cluster` Layer. Unless `namespace` is set, a
 * `Rivet.Namespace` is created for the stage.
 *
 * ### Using an existing control plane
 * **Example:** Connect to a control plane by URL and admin token
 * ```typescript
 * export const Cluster = Rivet.ControlPlane("Rivet", {
 *   endpoint: "https://rivet.example.com",
 *   token: Config.Redacted("RIVET_TOKEN"),
 * });
 * ```
 *
 * @primitive
 */
export const ControlPlane = (
  id: string,
  props: ControlPlaneProps,
): Layer.Layer<Cluster, Config.ConfigError, Provider<Namespace>> =>
  Layer.effect(
    Cluster,
    Effect.gen(function* () {
      const token = Config.isConfig(props.token) ? yield* props.token : props.token;
      if (globalThis.__ALCHEMY_RUNTIME__ || props.namespace !== undefined) {
        // At runtime a node or client reads its endpoint and namespace from its own
        // environment; the cluster is only consulted while deploying.
        return { endpoint: props.endpoint, token, namespace: props.namespace ?? "default" };
      }
      const namespace = yield* Namespace(`${id}Namespace`, { endpoint: props.endpoint, token });
      return { endpoint: props.endpoint, token, namespace: namespace.name };
    }),
  );
