import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";

/**
 * A GCP subnetwork a control plane's private address is on. Pools that run
 * nodes on GCP join it and connect to that address.
 */
export interface Network {
  readonly kind: "gcp";
  /** The VPC network's name. */
  readonly network: Input<string>;
  /** The subnetwork nodes run in. */
  readonly subnetwork: Input<string>;
  /** The subnetwork's region, where nodes run unless their pool names one. */
  readonly region: Input<string>;
}

/**
 * A GCP subnetwork, for `Rivet.ControlPlane`'s `network`: a
 * `GCP.Compute.Subnetwork` the stack declares, or one it looks up.
 *
 * ```typescript
 * network: RivetGCP.Network(subnetwork),
 * network: RivetGCP.Network(GCP.Compute.Subnetwork.lookup({ subnetworkName: "default" })),
 * ```
 */
export const Network = (subnetwork: {
  /** The parent network's URL. */
  readonly network: Input<string>;
  readonly subnetworkName: Input<string>;
  readonly region: Input<string>;
}): Network => ({
  kind: "gcp",
  // The subnetwork names its network by URL; nodes take the name.
  network: (Output.isOutput(subnetwork.network)
    ? subnetwork.network
    : Output.literal(subnetwork.network)
  ).pipe(Output.map((url) => String(url).split("/").pop() ?? "")),
  subnetwork: subnetwork.subnetworkName,
  region: subnetwork.region,
});
