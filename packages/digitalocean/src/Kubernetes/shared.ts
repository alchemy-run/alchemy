import type { KubernetesNodePool } from "@distilled.cloud/digitalocean";
import { setEquals } from "../internal/equal.ts";

export type NodePoolTaint = {
  key: string;
  value?: string;
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
};

/** A node pool's settings, shared by the cluster's default pool and `NodePool`. */
export type NodePoolSettings = {
  /** Droplet size slug for the nodes, for example `"s-2vcpu-4gb"`. */
  size: string;
  /** Number of nodes; with `autoScale`, the starting count. */
  count: number;
  /** Scale the pool between `minNodes` and `maxNodes`. @default false */
  autoScale?: boolean;
  /** Smallest pool when `autoScale` is on. */
  minNodes?: number;
  /** Largest pool when `autoScale` is on. */
  maxNodes?: number;
  /** Kubernetes labels on every node. */
  labels?: Record<string, string>;
  /** Kubernetes taints on every node. */
  taints?: NodePoolTaint[];
  /** DigitalOcean tags on the node droplets. */
  tags?: string[];
};

export const nodePoolBody = (name: string, settings: NodePoolSettings) => ({
  name,
  size: settings.size,
  count: settings.count,
  auto_scale: settings.autoScale ?? false,
  min_nodes: settings.minNodes,
  max_nodes: settings.maxNodes,
  labels: settings.labels ?? {},
  taints: settings.taints ?? [],
  tags: settings.tags ?? [],
});

const taintKeys = (taints: ReadonlyArray<{ key?: string; value?: string; effect?: string }>) =>
  taints.map((t) => `${t.key ?? ""}=${t.value ?? ""}:${t.effect ?? ""}`);

// DigitalOcean adds its own `k8s`, `k8s:<id>` and `k8s:worker` tags to pools.
const userTags = (tags: ReadonlyArray<string>) => tags.filter((tag) => !tag.startsWith("k8s"));

export const nodePoolInSync = (
  pool: KubernetesNodePool,
  name: string,
  settings: NodePoolSettings,
) =>
  pool.name === name &&
  pool.count === settings.count &&
  (pool.auto_scale ?? false) === (settings.autoScale ?? false) &&
  (!settings.autoScale ||
    (pool.min_nodes === settings.minNodes && pool.max_nodes === settings.maxNodes)) &&
  JSON.stringify(pool.labels ?? {}) === JSON.stringify(settings.labels ?? {}) &&
  setEquals(taintKeys(pool.taints ?? []), taintKeys(settings.taints ?? [])) &&
  setEquals(userTags(pool.tags ?? []), settings.tags ?? []);
