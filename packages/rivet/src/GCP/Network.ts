import type { Input } from "alchemy/Input";

/**
 * A GCP VPC network a control plane's private address is on. Pools that run
 * nodes on GCP join it and connect to that address.
 */
export interface Network {
  readonly kind: "gcp";
  /** The VPC network's name. */
  readonly network: Input<string>;
  /** The subnetwork nodes run in. */
  readonly subnetwork: Input<string>;
  /** The subnetwork's region, where nodes run unless their pool names one. */
  readonly region: string;
}

/**
 * A GCP VPC network, for `Rivet.ControlPlane`'s `network`.
 *
 * ```typescript
 * network: RivetGCP.Network({
 *   network: "rivet",
 *   subnetwork: "rivet-us-central1",
 *   region: "us-central1",
 * }),
 * ```
 */
export const Network = (props: Omit<Network, "kind">): Network => ({ kind: "gcp", ...props });
