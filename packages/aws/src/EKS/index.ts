export * from "./AccessEntry.ts";
export * from "./Addon.ts";
export * from "./Cluster.ts";
export * from "./KubernetesAdapter.ts";
export * from "./DescribeAccessEntry.ts";
export * from "./DescribeAddon.ts";
export * from "./DescribeAddonConfiguration.ts";
export * from "./DescribeAddonVersions.ts";
export * from "./DescribeCapability.ts";
export * from "./DescribeCluster.ts";
export * from "./DescribeClusterVersions.ts";
export * from "./DescribeFargateProfile.ts";
export * from "./DescribeIdentityProviderConfig.ts";
export * from "./DescribeInsight.ts";
export * from "./DescribeInsightsRefresh.ts";
export * from "./DescribeNodegroup.ts";
export * from "./DescribePodIdentityAssociation.ts";
export * from "./DescribeUpdate.ts";
export * from "./FargateProfile.ts";
export * from "./ListAccessEntries.ts";
export * from "./ListAccessPolicies.ts";
export * from "./ListAddons.ts";
export * from "./ListAssociatedAccessPolicies.ts";
export * from "./ListCapabilities.ts";
export * from "./ListClusters.ts";
export * from "./ListFargateProfiles.ts";
export * from "./ListIdentityProviderConfigs.ts";
export * from "./ListInsights.ts";
export * from "./ListNodegroups.ts";
export * from "./ListPodIdentityAssociations.ts";
export * from "./ListUpdates.ts";
export * from "./Nodegroup.ts";
export * from "./PodIdentityAssociation.ts";
export * from "./StartInsightsRefresh.ts";

/**
 * @deprecated The Kubernetes workloads moved to the cluster-agnostic
 * `@alchemy.run/kubernetes` namespace (`Kubernetes.Deployment`,
 * `Kubernetes.Job`, `Kubernetes.Manifest`, `Kubernetes.HelmChart`) — they
 * take an `AWS.EKS.Cluster` (or any cluster) as their `cluster` prop and
 * are registered by `Kubernetes.providers()`. These re-exports keep old
 * imports compiling for one release; existing state migrates in place via
 * type aliases.
 */
export { Deployment, HelmChart, Job, Manifest } from "@alchemy.run/kubernetes";
