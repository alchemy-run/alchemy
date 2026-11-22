import type { Connection } from "@alchemy.run/kubernetes/Connection";

declare module "@alchemy.run/kubernetes/Connection" {
  interface AuthRegistry {
    /**
     * Reach an AKS cluster through Azure Resource Manager: the API server
     * endpoint, its certificate authority, and the credentials come from the
     * cluster's admin kubeconfig (or, when local accounts are disabled, a
     * Microsoft Entra token of the deployer). Contributed by
     * `Azure.providers()`; `Azure.ContainerService.ManagedCluster`
     * attributes carry a ready-made `connection` with this descriptor.
     */
    "azure-aks": {
      /** Name of the managed cluster. */
      clusterName: string;
      /** Resource group of the managed cluster. */
      resourceGroup: string;
      /**
       * Subscription of the managed cluster.
       * @default the deployer's subscription
       */
      subscriptionId?: string;
    };
  }
}

/** `/subscriptions/<id>/...` → `<id>`. */
const subscriptionOf = (armId: string | undefined) =>
  armId?.match(/^\/subscriptions\/([^/]+)/i)?.[1];

/**
 * The `Kubernetes.Connection` of an AKS cluster, stamped on
 * `Azure.ContainerService.ManagedCluster` attributes so the cluster can be
 * passed as any `Kubernetes.*` workload's `cluster`.
 */
export const aksConnectionOf = (options: {
  clusterId: string | undefined;
  clusterName: string;
  resourceGroup: string;
  fqdn: string | undefined;
}): Connection => {
  const subscriptionId = subscriptionOf(options.clusterId);
  return {
    ...(options.fqdn ? { endpoint: `https://${options.fqdn}:443` } : {}),
    auth: {
      kind: "azure-aks",
      clusterName: options.clusterName,
      resourceGroup: options.resourceGroup,
      ...(subscriptionId !== undefined ? { subscriptionId } : {}),
    },
  };
};
