export * from "./AccessEntry.ts";
export * from "./Addon.ts";
export * from "./Cluster.ts";
export * from "./KubernetesAdapter.ts";
export * from "./FargateProfile.ts";
export * from "./Nodegroup.ts";
export * from "./PodIdentityAssociation.ts";

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
export * from "./generated.ts";
