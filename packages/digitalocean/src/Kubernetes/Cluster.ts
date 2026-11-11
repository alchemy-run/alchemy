import type { Connection } from "@alchemy.run/kubernetes/Connection";
import * as DO from "@distilled.cloud/digitalocean";
import type { ClusterRead } from "@distilled.cloud/digitalocean";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { setEquals } from "../internal/equal.ts";
import { ignoreNotFound, noneIfNotFound } from "../internal/notFound.ts";
import {
  generationTagFor,
  isAlchemyTag,
  ownershipTagFor,
  withoutAlchemyTags,
} from "../internal/ownership.ts";
import { pollUntil, type PollBudget } from "../internal/poll.ts";
import { desiredTagsFor, rejectReservedTags } from "../internal/tags.ts";
import type { Providers } from "../Providers.ts";
import type { RegionSlug } from "../Slugs.ts";
import { doksConnectionOf } from "./KubernetesAdapter.ts";
import { nodePoolBody, nodePoolInSync, type NodePoolSettings } from "./shared.ts";

export type ClusterProps = {
  /**
   * Cluster name, unique within the team. A change renames the cluster in
   * place.
   *
   * @default a generated physical name
   */
  name?: string;
  /** Region slug. A change replaces the cluster. */
  region: RegionSlug;
  /**
   * Kubernetes version slug (`"1.33.1-do.0"`) or `"latest"`. A newer
   * version upgrades the cluster in place.
   *
   * @default "latest"
   */
  version?: string;
  /** VPC for the nodes. A change replaces the cluster. */
  vpcUuid?: string;
  /** Pod CIDR. A change replaces the cluster. */
  clusterSubnet?: string;
  /** Service CIDR. A change replaces the cluster. */
  serviceSubnet?: string;
  /**
   * The cluster's default node pool. Count, autoscaling, labels, taints and
   * tags update in place; a new `size` replaces the cluster.
   */
  nodePool: NodePoolSettings & {
    /** Pool name. @default "default" */
    name?: string;
  };
  /** Highly available control plane. Turning it on updates in place; it cannot be turned off. */
  ha?: boolean;
  /** Apply patch releases in the maintenance window. @default false */
  autoUpgrade?: boolean;
  /** Add surge nodes during upgrades. @default false */
  surgeUpgrade?: boolean;
  /** Weekly maintenance window, for example `{ startTime: "03:00", day: "sunday" }`. */
  maintenancePolicy?: {
    startTime: string;
    day: "any" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";
  };
  /** Allow only these addresses to reach the control plane. */
  controlPlaneAllowedAddresses?: string[];
  /** Tags to assign. The `alchemy:` prefix is reserved. A change updates in place. */
  tags?: string[];
  /**
   * Also destroy the load balancers and volumes the cluster created for
   * Services and PersistentVolumeClaims when the cluster is destroyed.
   *
   * @default false
   */
  destroyAssociatedResources?: boolean;
};

export type Cluster = Resource<
  "DigitalOcean.Kubernetes.Cluster",
  ClusterProps,
  {
    /** Cluster id (UUID). */
    clusterId: string;
    /** Uniform resource name, `do:kubernetes:<id>`, for `ProjectResources`. */
    urn: string;
    /** Cluster name. */
    name: string;
    /** Region slug. */
    region: string;
    /** Kubernetes version slug. */
    version: string;
    /** API server URL. */
    endpoint: string;
    /** Public IPv4 address of the control plane. */
    ipv4: string | undefined;
    /** `running` once usable. */
    status: string;
    /** VPC id. */
    vpcUuid: string;
    /** Pod CIDR. */
    clusterSubnet: string;
    /** Service CIDR. */
    serviceSubnet: string;
    /** Id of the default node pool. */
    defaultNodePoolId: string;
    /** Tags without the `alchemy:` and `k8s` tags. */
    tags: string[];
    /** The `Kubernetes.Connection` for `Kubernetes.*` workloads on this cluster. */
    connection: Connection;
    /** ISO 8601 creation time. */
    createdAt: string;
  },
  never,
  Providers
>;

export type ClusterAttributes = Cluster["Attributes"];

/**
 * A DigitalOcean Kubernetes (DOKS) cluster with its default node pool.
 * Pass `cluster.connection` to `Kubernetes.Deployment`, `Kubernetes.Manifest`
 * and the other `@alchemy.run/kubernetes` workloads; Alchemy connects with
 * short-lived tokens from the DigitalOcean API. Add more pools with
 * `DigitalOcean.Kubernetes.NodePool`.
 *
 * Alchemy tags the cluster with an `alchemy:` ownership tag and an
 * `alchemy:generation:` tag, so an interrupted deploy resumes on the cluster
 * it already created. A same-named cluster without the ownership tag is
 * `Unowned` and needs `--adopt`. A cluster takes five to ten minutes to
 * come up.
 *
 * ### Creating a Cluster
 * **Example:** A three-node cluster
 * ```typescript
 * const cluster = yield* DigitalOcean.Kubernetes.Cluster("k8s", {
 *   region: "nyc3",
 *   nodePool: { size: "s-2vcpu-4gb", count: 3 },
 * });
 * ```
 *
 * **Example:** An autoscaling, highly available cluster in a VPC
 * ```typescript
 * const network = yield* DigitalOcean.Vpc("network", { region: "nyc3" });
 * const cluster = yield* DigitalOcean.Kubernetes.Cluster("k8s", {
 *   region: "nyc3",
 *   vpcUuid: network.vpcId,
 *   ha: true,
 *   autoUpgrade: true,
 *   maintenancePolicy: { startTime: "03:00", day: "sunday" },
 *   nodePool: { size: "s-4vcpu-8gb", count: 2, autoScale: true, minNodes: 2, maxNodes: 6 },
 * });
 * ```
 *
 * ### Running Workloads
 * **Example:** Deploy a container to the cluster
 * ```typescript
 * const cluster = yield* DigitalOcean.Kubernetes.Cluster("k8s", {
 *   region: "nyc3",
 *   nodePool: { size: "s-2vcpu-4gb", count: 2 },
 * });
 * yield* Kubernetes.Deployment("web", {
 *   connection: cluster.connection,
 *   image: "nginx:1.27",
 *   replicas: 2,
 *   ports: [{ containerPort: 80 }],
 * });
 * ```
 *
 * @see https://docs.digitalocean.com/reference/api/digitalocean/#tag/Kubernetes
 *
 * @resource
 * @product Kubernetes
 * @category Containers
 */
export const Cluster = Resource<Cluster>("DigitalOcean.Kubernetes.Cluster");

export class ClusterTagReserved extends Data.TaggedError(
  "DigitalOcean.Kubernetes.ClusterTagReserved",
)<{
  readonly tag: string;
}> {
  override get message() {
    return `Tag '${this.tag}' uses the 'alchemy:' prefix, which is reserved for ownership tags.`;
  }
}

export class ClusterWaitTimedOut extends Data.TaggedError(
  "DigitalOcean.Kubernetes.ClusterWaitTimedOut",
)<{
  readonly clusterId: string;
  readonly waitingFor: string;
  readonly lastState: string | undefined;
}> {
  override get message() {
    return `Kubernetes cluster ${this.clusterId} timed out waiting for ${this.waitingFor} (last state: ${this.lastState ?? "missing"}).`;
  }
}

// A cluster takes five to ten minutes to run; an upgrade can take longer
// (≈ 25 min budget).
const PROVISIONING_POLL: PollBudget = { maxDelay: "20 seconds", times: 80 };

const physicalName = (id: string) => createPhysicalName({ id, lowercase: true, maxLength: 63 });

// DigitalOcean adds its own `k8s` and `k8s:<id>` tags to a cluster.
const userTagsOf = (tags: ReadonlyArray<string>) =>
  withoutAlchemyTags(tags).filter((tag) => !tag.startsWith("k8s"));

const toAttrs = (cluster: ClusterRead): ClusterAttributes => ({
  clusterId: cluster.id,
  urn: `do:kubernetes:${cluster.id}`,
  name: cluster.name,
  region: cluster.region,
  version: cluster.version,
  endpoint: cluster.endpoint,
  ipv4: cluster.ipv4 || undefined,
  status: cluster.status.state ?? "unknown",
  vpcUuid: cluster.vpc_uuid,
  clusterSubnet: cluster.cluster_subnet,
  serviceSubnet: cluster.service_subnet,
  defaultNodePoolId: cluster.node_pools[0]?.id ?? "",
  tags: userTagsOf(cluster.tags),
  connection: doksConnectionOf({ clusterId: cluster.id, endpoint: cluster.endpoint }),
  createdAt: cluster.created_at,
});

export const observeKubernetesCluster = (clusterId: string) =>
  noneIfNotFound(
    DO.getKubernetesCluster({ cluster_id: clusterId }).pipe(
      Effect.map((r) => r.kubernetes_cluster),
    ),
  );

const listAll = DO.listKubernetesClusters({ per_page: 200 }).pipe(
  Effect.map((r) => r.kubernetes_clusters ?? []),
);

const observeGeneration = Effect.fn(function* (
  output: ClusterAttributes | undefined,
  instanceId: string,
) {
  if (output !== undefined) {
    const byId = yield* observeKubernetesCluster(output.clusterId);
    if (Option.isSome(byId)) return byId;
  }
  const tag = generationTagFor(instanceId);
  const clusters = yield* listAll;
  const found = clusters.find((cluster) => (cluster.tags ?? []).includes(tag));
  return found === undefined ? Option.none() : yield* observeKubernetesCluster(found.id);
});

/** Waits until the cluster runs and matches `until`. */
export const waitUntilRunning = (
  clusterId: string,
  until: (cluster: ClusterRead) => boolean = () => true,
) =>
  pollUntil(observeKubernetesCluster(clusterId), {
    ...PROVISIONING_POLL,
    until: (o): o is Option.Some<ClusterRead> =>
      Option.isSome(o) && o.value.status.state === "running" && until(o.value),
    onTimeout: (last) =>
      new ClusterWaitTimedOut({
        clusterId,
        waitingFor: "the running state",
        lastState: Option.getOrUndefined(last)?.status.state,
      }),
  }).pipe(Effect.map((o) => o.value));

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: [
      "clusterId",
      "urn",
      "region",
      "vpcUuid",
      "clusterSubnet",
      "serviceSubnet",
      "createdAt",
    ],
    list: Effect.fn(function* () {
      const clusters = yield* listAll;
      return clusters.filter((c) => (c.tags ?? []).some(isAlchemyTag)).map(toAttrs);
    }),
    read: Effect.fn(function* ({ fqn, instanceId, olds, output }) {
      const owned = yield* observeGeneration(output, instanceId);
      if (Option.isSome(owned)) return toAttrs(owned.value);
      if (olds.name === undefined) return undefined;
      const ownershipTag = yield* ownershipTagFor(fqn);
      const clusters = yield* listAll;
      const named = clusters.find(
        (c) => c.name === olds.name && !(c.tags ?? []).includes(ownershipTag),
      );
      if (named === undefined) return undefined;
      const full = yield* observeKubernetesCluster(named.id);
      return Option.getOrUndefined(Option.map(full, (c) => Unowned(toAttrs(c))));
    }),
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (
        news.region !== olds.region ||
        news.vpcUuid !== olds.vpcUuid ||
        news.clusterSubnet !== olds.clusterSubnet ||
        news.serviceSubnet !== olds.serviceSubnet ||
        news.nodePool.size !== olds.nodePool.size ||
        (olds.ha === true && news.ha !== true)
      ) {
        return { action: "replace" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, fqn, instanceId, news, output }) {
      yield* rejectReservedTags(news.tags, (tag) => new ClusterTagReserved({ tag }));
      const tags = yield* desiredTagsFor(news.tags, fqn, instanceId);
      const name = news.name ?? (yield* physicalName(id));
      const poolName = news.nodePool.name ?? "default";

      const observed = yield* observeGeneration(output, instanceId);
      const created = yield* Option.match(observed, {
        onNone: () =>
          DO.createKubernetesCluster({
            name,
            region: news.region,
            version: news.version ?? "latest",
            vpc_uuid: news.vpcUuid,
            cluster_subnet: news.clusterSubnet,
            service_subnet: news.serviceSubnet,
            tags: [...tags],
            node_pools: [nodePoolBody(poolName, news.nodePool)],
            ha: news.ha,
            auto_upgrade: news.autoUpgrade ?? false,
            surge_upgrade: news.surgeUpgrade ?? false,
            maintenance_policy:
              news.maintenancePolicy === undefined
                ? undefined
                : { start_time: news.maintenancePolicy.startTime, day: news.maintenancePolicy.day },
            control_plane_firewall:
              news.controlPlaneAllowedAddresses === undefined
                ? undefined
                : { enabled: true, allowed_addresses: news.controlPlaneAllowedAddresses },
          }).pipe(Effect.map((r) => r.kubernetes_cluster)),
        onSome: Effect.succeed,
      });
      let cluster = yield* waitUntilRunning(created.id);

      const settingsInSync =
        cluster.name === name &&
        setEquals(
          cluster.tags.filter((t) => !t.startsWith("k8s")),
          tags,
        ) &&
        (cluster.auto_upgrade ?? false) === (news.autoUpgrade ?? false) &&
        (cluster.surge_upgrade ?? false) === (news.surgeUpgrade ?? false) &&
        (news.ha !== true || cluster.ha === true) &&
        (news.maintenancePolicy === undefined ||
          (cluster.maintenance_policy?.start_time === news.maintenancePolicy.startTime &&
            cluster.maintenance_policy?.day === news.maintenancePolicy.day)) &&
        setEquals(
          cluster.control_plane_firewall?.allowed_addresses ?? [],
          news.controlPlaneAllowedAddresses ?? [],
        );
      if (!settingsInSync) {
        yield* DO.updateKubernetesCluster({
          cluster_id: cluster.id,
          name,
          tags: [...tags],
          auto_upgrade: news.autoUpgrade ?? false,
          surge_upgrade: news.surgeUpgrade ?? false,
          ha: news.ha,
          maintenance_policy:
            news.maintenancePolicy === undefined
              ? undefined
              : { start_time: news.maintenancePolicy.startTime, day: news.maintenancePolicy.day },
          control_plane_firewall: {
            enabled: news.controlPlaneAllowedAddresses !== undefined,
            allowed_addresses: news.controlPlaneAllowedAddresses ?? [],
          },
        });
      }

      const pool = cluster.node_pools.find((p) => p.name === poolName) ?? cluster.node_pools[0];
      if (pool?.id !== undefined && !nodePoolInSync(pool, poolName, news.nodePool)) {
        const { size: _size, ...settings } = nodePoolBody(poolName, news.nodePool);
        yield* DO.updateKubernetesNodePool({
          cluster_id: cluster.id,
          node_pool_id: pool.id,
          ...settings,
        });
      }

      const version = news.version;
      if (version !== undefined && version !== "latest" && cluster.version !== version) {
        yield* DO.kubernetesUpgradeCluster({ cluster_id: cluster.id, version });
        cluster = yield* waitUntilRunning(cluster.id, (c) => c.version === version);
      }

      return toAttrs(yield* waitUntilRunning(cluster.id, (c) => c.name === name));
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observeKubernetesCluster(output.clusterId);
      if (Option.isNone(observed)) return;
      if (olds.destroyAssociatedResources) {
        yield* DO.kubernetesDestroyAssociatedResourcesDangerous({ cluster_id: output.clusterId });
      } else {
        yield* ignoreNotFound(DO.deleteKubernetesCluster({ cluster_id: output.clusterId }));
      }
      yield* pollUntil(observeKubernetesCluster(output.clusterId), {
        ...PROVISIONING_POLL,
        until: (o) => Option.isNone(o) || o.value.status.state === "deleted",
        onTimeout: () =>
          new ClusterWaitTimedOut({
            clusterId: output.clusterId,
            waitingFor: "deletion",
            lastState: undefined,
          }),
      });
    }),
  });
