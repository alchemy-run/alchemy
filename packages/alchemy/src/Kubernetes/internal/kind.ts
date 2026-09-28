import type { KindClusterConfig } from "../LocalCluster.ts";

/**
 * containerd patch enabling the per-registry `hosts.toml` directory that
 * points `localhost:<registryPort>` at the local registry container. The
 * default on kind v0.27+ node images; kept for older ones
 * (https://kind.sigs.k8s.io/docs/user/local-registry/).
 */
export const REGISTRY_CONTAINERD_PATCH = `[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"`;

/**
 * The kind cluster config `LocalCluster` passes to `kind create cluster`:
 * the user's config with the kind/apiVersion header and the registry
 * containerd patch added. kind reads YAML, and JSON is valid YAML.
 */
export const kindClusterConfig = (config: KindClusterConfig | undefined) => ({
  ...config,
  kind: "Cluster",
  apiVersion: "kind.x-k8s.io/v1alpha4",
  containerdConfigPatches: [
    ...(config?.containerdConfigPatches ?? []),
    REGISTRY_CONTAINERD_PATCH,
  ],
});
