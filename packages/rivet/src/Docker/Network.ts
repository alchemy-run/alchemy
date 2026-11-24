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

/** A Docker network, for `Rivet.ControlPlane`'s `network`. */
export const Network = (props: Omit<Network, "kind">): Network => ({ kind: "docker", ...props });
