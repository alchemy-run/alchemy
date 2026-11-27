import type { Input } from "alchemy/Input";

/**
 * A Docker network a control plane's private address is on. Node
 * containers join it by name.
 */
export interface Network {
  readonly kind: "docker";
  /** The network's name. */
  readonly name: Input<string>;
}

/**
 * A Docker network, for `Rivet.ControlPlane`'s `network`: a
 * `Docker.Network` the stack declares, or one it looks up.
 *
 * ```typescript
 * network: RivetDocker.Network(Docker.Network.lookup({ name: "compose_default" })),
 * ```
 */
export const Network = (network: { readonly name: Input<string> }): Network => ({
  kind: "docker",
  name: network.name,
});
