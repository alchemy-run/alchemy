/**
 * A Kubernetes cluster a control plane's private address is on. Nodes run
 * in its namespace.
 */
export interface Network {
  readonly kind: "kubernetes";
  /** The cluster (a `Kubernetes.ClusterLike`). */
  readonly cluster: unknown;
  /** The namespace nodes run in. */
  readonly namespace: string;
}

/** A Kubernetes cluster, for `Rivet.ControlPlane`'s `network`. */
export const Network = (props: Omit<Network, "kind">): Network => ({
  kind: "kubernetes",
  ...props,
});
