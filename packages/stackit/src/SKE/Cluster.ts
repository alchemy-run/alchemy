import type { Connection, ContainerRegistry } from "@alchemy.run/kubernetes/Connection";
import * as ske from "@distilled.cloud/stackit/ske";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { unwrapRedacted } from "alchemy/Util/data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredLabels, hasAlchemyLabels, isAlchemyOwned, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  CLUSTER_DELETE_TIMEOUT,
  CLUSTER_READY_TIMEOUT,
  type ClusterSpec,
  clusterState,
  describeClusterState,
  getClusterOrUndefined,
  isClusterReady,
  isClusterTransitioning,
  MAX_CLUSTER_NAME_LENGTH,
  requireMinimumVersion,
  sameClusterSpec,
  SKE_SERVICE_ID,
  skeConnectionOf,
} from "./internal.ts";

/** Default OS image, volume type and volume size: Terraform's defaults. */
const DEFAULT_IMAGE_NAME = "flatcar";
const DEFAULT_VOLUME_TYPE = "storage_premium_perf1";
const DEFAULT_VOLUME_SIZE = 20;

/** A node pool's taint. */
export interface ClusterNodepoolTaint {
  /** Effect of the taint on pods that don't tolerate it. */
  effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
  /** Taint key. */
  key: string;
  /** Taint value. */
  value?: string;
}

/** A pool of worker nodes. */
export interface ClusterNodepool {
  /** Name of the pool, at most 15 characters. It identifies the pool across updates. */
  name: string;
  /** Machine type of the nodes. Valid values: `listProviderOptions`' `machineTypes`. */
  machineType: string;
  /**
   * OS image name. Valid values: `listProviderOptions`' `machineImages`.
   * @default "flatcar"
   */
  imageName?: string;
  /**
   * Minimum OS image version, `x.y.z` or a prefix of it. Maintenance can upgrade
   * the live version past it; a live version above it is kept, never downgraded.
   * @default the latest supported version of `imageName`
   */
  imageVersion?: string;
  /** Minimum node count, 0-1000. The sum over all pools must not exceed 1000. */
  minimum: number;
  /** Maximum node count, 1-1000. */
  maximum: number;
  /**
   * Additional nodes created during an update. When above zero, it must be at
   * least the number of availability zones.
   * @default STACKIT's default
   */
  maxSurge?: number;
  /**
   * Nodes that can be unavailable during an update. When above zero, it must be
   * at least the number of availability zones.
   * @default STACKIT's default
   */
  maxUnavailable?: number;
  /** Availability zones of the nodes, e.g. `eu01-1`. */
  availabilityZones: string[];
  /**
   * Size of each node's volume in GB, 20-10240.
   * @default 20
   */
  volumeSize?: number;
  /**
   * Type of each node's volume. Valid values: `listProviderOptions`'
   * `volumeTypes`.
   * @default "storage_premium_perf1"
   */
  volumeType?: string;
  /**
   * Whether system components may run on this pool. At least one pool of a
   * cluster needs it.
   * @default true
   */
  allowSystemComponents?: boolean;
  /** Labels of the pool's nodes. Omit to keep the live labels. */
  labels?: Record<string, string>;
  /** Taints of the pool's nodes. Omit to keep the live taints. */
  taints?: ClusterNodepoolTaint[];
  /** Container runtime settings. `kata` is in private preview. */
  cri?: { name?: string; kata?: { enabled: boolean } };
  /**
   * Minimum kubelet version of this pool. At most one minor below the cluster's,
   * and existing pools can't be downgraded, so a live version above it is kept.
   */
  kubernetesVersion?: string;
}

/** The cluster's network. Everything but `cni` replaces the cluster when changed. */
export interface ClusterNetwork {
  /**
   * Id of the STACKIT Network Area network the cluster runs in, e.g. a
   * `Stackit.IaaS.Network`'s `networkId`. Changing it replaces the cluster.
   * @default a network STACKIT creates
   */
  id?: string;
  /**
   * Whether the control plane is public or only reachable inside the network
   * area. Private preview. Changing it replaces the cluster.
   * @default "PUBLIC"
   */
  accessScope?: "PUBLIC" | "SNA";
  /** CIDRs for pod IPs; STACKIT allows one. Immutable: changing it replaces the cluster. */
  podAddressRanges?: string[];
  /** CIDRs for Service IPs; STACKIT allows one. Immutable: changing it replaces the cluster. */
  serviceAddressRanges?: string[];
  /** CNI configuration. Calico is what STACKIT defaults to. */
  cni?: { calico?: unknown };
}

/** One hibernation window. */
export interface ClusterHibernationSchedule {
  /** Cron expression that starts the hibernation, e.g. `0 20 * * *`. */
  start: string;
  /** Cron expression that ends it, e.g. `0 8 * * *`. */
  end: string;
  /** Time zone of the expressions. */
  timezone?: string;
}

/** The cluster's maintenance settings. */
export interface ClusterMaintenance {
  /** What maintenance may upgrade by itself. */
  autoUpdate?: { kubernetesVersion?: boolean; machineImageVersion?: boolean };
  /**
   * Daily maintenance window, as RFC 3339 times of day (`05:00:00Z`,
   * `05:00:00+02:00`). A full date-time is accepted; its date is ignored.
   */
  timeWindow?: { start: string; end: string };
}

/** Optional cluster extensions. Set `enabled: false` to turn one off. */
export interface ClusterExtensions {
  /** Restrict access to the Kubernetes API to these CIDRs. */
  acl?: { enabled: boolean; allowedCidrs: string[] };
  /** ExternalDNS, serving these zones (e.g. a `Stackit.DNS.Zone`'s `dnsName`). */
  dns?: { enabled: boolean; zones?: string[]; gatewayApi?: boolean };
  /** Send metrics to a `Stackit.Observability` instance. */
  observability?: { enabled: boolean; instanceId: string };
  /** The application load balancer extension. Private preview. */
  applicationLoadBalancer?: { enabled: boolean };
}

export interface ClusterProps {
  /**
   * Cluster name: 1-11 lowercase alphanumerics or `-`, starting and ending with
   * an alphanumeric. Changing it replaces the cluster.
   *
   * If omitted, a unique name is generated: the 11-character limit leaves room
   * for a hash and a suffix only, so it carries no readable prefix. Alchemy's
   * ownership labels say what it belongs to.
   */
  name?: string;
  /**
   * Minimum Kubernetes version, `x.y.z` or `x.y`. Maintenance can upgrade the
   * live version past it; a live version above it is kept, never downgraded. See
   * the live version in the `kubernetesVersion` attribute.
   * @default the latest supported version at creation
   */
  kubernetesVersion?: string;
  /** Worker node pools. At least one needs `allowSystemComponents`. */
  nodepools: ClusterNodepool[];
  /** Network settings. Omit to keep what the cluster has. */
  network?: ClusterNetwork;
  /**
   * Hibernation windows. The control plane stays billed while hibernated. Pass
   * an empty list to remove them; omit to keep the live ones.
   */
  hibernation?: { schedules: ClusterHibernationSchedule[] };
  /** Maintenance settings. Omit to keep the live ones. */
  maintenance?: ClusterMaintenance;
  /** Extensions. An omitted extension keeps its live settings. */
  extensions?: ClusterExtensions;
  /** Access settings. Omit to keep the live ones. */
  access?: { idp?: { enabled: boolean; type: string } };
  /** Audit log forwarding to a Telemetry Router. Private preview. */
  audit?: { enabled: boolean };
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`) are always merged in.
   */
  labels?: Record<string, string>;
  /**
   * Where `Kubernetes.*` workloads with a `main` or a `context` push their
   * images. The nodes must be able to pull from it. Carried on the cluster's
   * `connection`; changing it updates the attribute and touches nothing on
   * STACKIT.
   */
  registry?: ContainerRegistry;
  /**
   * CPU architecture of the nodes, the default target of workload image builds.
   * Carried on the cluster's `connection`.
   * @default "amd64"
   */
  architecture?: "amd64" | "arm64";
  /** Project that owns the cluster. Defaults to the profile's. Changing it replaces the cluster. */
  projectId?: string;
  /** Region of the cluster. Defaults to the profile's. Changing it replaces the cluster. */
  region?: string;
}

export interface ClusterAttributes {
  /** Name of the cluster. Stable across updates. */
  clusterName: string;
  /** Project that owns the cluster. */
  projectId: string;
  /** Region of the cluster. */
  region: string;
  /**
   * How to reach the cluster, without credentials. Passing the cluster resource
   * as a `Kubernetes.*` workload's `cluster` reads it.
   */
  connection: Connection;
  /** Live Kubernetes version. Maintenance may raise it. */
  kubernetesVersion: string;
  /** Aggregated state, `STATE_HEALTHY` or `STATE_HIBERNATED` after a deploy. */
  state: string | undefined;
  /** Whether the cluster is hibernated. */
  hibernated: boolean;
  /** Outgoing CIDRs of traffic from the cluster's workloads. */
  egressAddressRanges: string[];
  /** CIDRs of the nodes. */
  nodeAddressRanges: string[];
  /** CIDRs of the pods. */
  podAddressRanges: string[];
  /** CIDRs of the Services. */
  serviceAddressRanges: string[];
  /** OIDC issuer of the cluster's Kubernetes service accounts. */
  serviceAccountIssuer: string | undefined;
  /** Identity of the cluster, as the API reports it. */
  identity: string | undefined;
  /** Network Area network the cluster runs in, if any. */
  networkId: string | undefined;
  /** Access scope of the control plane. */
  accessScope: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** Live node pools, with the versions maintenance left them on. */
  nodepools: ske.Nodepool[];
  /** When the cluster was created. */
  creationTime: string | undefined;
}

export type Cluster = Resource<
  "Stackit.SKE.Cluster",
  ClusterProps,
  ClusterAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Kubernetes Engine (SKE) cluster: a managed control plane plus worker
 * node pools, the general container runtime on STACKIT.
 *
 * Deploys wait until the cluster reports `STATE_HEALTHY` or `STATE_HIBERNATED`,
 * up to 45 minutes; destroys wait until it is gone, up to 90 minutes (the budgets
 * in STACKIT's Go SDK). The first deploy also enables the SKE service
 * (`cloud.stackit.ske`) for the project.
 *
 * The cluster is billed per started hour from creation until it is deleted, and
 * hibernation only stops the workers: the control plane keeps billing.
 *
 * Ownership is tracked with cluster labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`). A cluster of the same name without them is reported as unowned
 * and only taken over with `--adopt`.
 *
 * ### Creating a Cluster
 * **Example:** One small pool, on the latest supported version
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Several pools, with labels and taints
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   name: "prod",
 *   nodepools: [
 *     {
 *       name: "system",
 *       machineType: "c1.4",
 *       availabilityZones: ["eu01-1", "eu01-2", "eu01-3"],
 *       minimum: 3,
 *       maximum: 3,
 *       maxSurge: 3,
 *     },
 *     {
 *       name: "batch",
 *       machineType: "c1.8",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 0,
 *       maximum: 10,
 *       allowSystemComponents: false,
 *       labels: { workload: "batch" },
 *       taints: [{ key: "batch", value: "true", effect: "NoSchedule" }],
 *       volumeSize: 100,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Choosing Versions
 * **Example:** Minimum Kubernetes and OS image versions
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Both are minimums: once maintenance has upgraded past them, Alchemy sends
 * // the live version back rather than asking for a downgrade.
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   kubernetesVersion: "1.32",
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *       imageName: "flatcar",
 *       imageVersion: "4230",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Running in a Network Area
 * **Example:** A cluster on an existing network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.0.0/24" },
 * });
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   network: { id: network.networkId },
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Operating the Cluster
 * **Example:** Maintenance window, auto-updates and nightly hibernation
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   maintenance: {
 *     autoUpdate: { kubernetesVersion: true, machineImageVersion: true },
 *     timeWindow: { start: "02:00:00Z", end: "04:00:00Z" },
 *   },
 *   hibernation: {
 *     schedules: [{ start: "0 20 * * *", end: "0 8 * * 1-5", timezone: "Europe/Berlin" }],
 *   },
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Extensions
 * **Example:** API allow-list and ExternalDNS for a STACKIT zone
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const zone = yield* Stackit.DNS.Zone("Zone", { dnsName: "apps.example.com" });
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   extensions: {
 *     acl: { enabled: true, allowedCidrs: ["203.0.113.0/24"] },
 *     dns: { enabled: true, zones: [zone.dnsName] },
 *   },
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Deploying Workloads
 * **Example:** Pass the cluster as a workload's `cluster`
 * ```typescript
 * import * as Kubernetes from "@alchemy.run/kubernetes";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * const api = yield* Kubernetes.Deployment("Api", {
 *   cluster,
 *   image: "ghcr.io/acme/api:v3",
 *   port: 8080,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the name recreates the cluster
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Moving from "staging" to "prod" creates the new cluster, repoints dependents
 * // and deletes the old one with everything running on it. Changing the network
 * // of a cluster with an explicit name deletes the old cluster FIRST, because
 * // one name can't exist twice: expect downtime.
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   name: "prod",
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export const Cluster = Resource<Cluster>("Stackit.SKE.Cluster");

type ConnectionProps = Pick<ClusterProps, "registry" | "architecture">;

const toAttrs = (
  projectId: string,
  region: string,
  clusterName: string,
  cluster: ske.Cluster,
  props: ConnectionProps | undefined,
): ClusterAttributes => ({
  clusterName,
  projectId,
  region,
  connection: skeConnectionOf({
    clusterName,
    projectId,
    region,
    registry: props?.registry,
    architecture: props?.architecture,
  }),
  kubernetesVersion: cluster.kubernetes.version,
  state: clusterState(cluster),
  hibernated: cluster.status?.hibernated ?? false,
  egressAddressRanges: [...(cluster.status?.egressAddressRanges ?? [])],
  nodeAddressRanges: [...(cluster.status?.nodeAddressRanges ?? [])],
  podAddressRanges: [
    ...(cluster.status?.podAddressRanges ?? cluster.network?.podAddressRanges ?? []),
  ],
  serviceAddressRanges: [
    ...(cluster.status?.serviceAddressRanges ?? cluster.network?.serviceAddressRanges ?? []),
  ],
  serviceAccountIssuer: cluster.status?.serviceAccountIssuer,
  identity: cluster.status?.identity,
  networkId: cluster.network?.id,
  accessScope: cluster.network?.controlPlane?.accessScope,
  labels: stripInternalLabels(cluster.labels),
  nodepools: [...cluster.nodepools],
  creationTime: cluster.status?.creationTime,
});

const generatedName = (id: string) =>
  createPhysicalName({ id, maxLength: MAX_CLUSTER_NAME_LENGTH, lowercase: true });

const resolveClusterName = (
  id: string,
  news: Pick<ClusterProps, "name">,
  output: Pick<ClusterAttributes, "clusterName"> | undefined,
) =>
  news.name !== undefined
    ? Effect.succeed(news.name)
    : output?.clusterName !== undefined
      ? Effect.succeed(output.clusterName)
      : generatedName(id);

/** A cluster being torn down is not a candidate for crash recovery. */
const isDeleting = (cluster: ske.Cluster) => clusterState(cluster) === "STATE_DELETING";

const findClusterByOwnership = (projectId: string, region: string, id: string) =>
  Effect.gen(function* () {
    const { items } = yield* ske.listClusters({ projectId, region });
    for (const cluster of items ?? []) {
      if (!isDeleting(cluster) && (yield* hasAlchemyLabels(id, cluster.labels))) return cluster;
    }
    return undefined;
  });

const waitForClusterGone = (projectId: string, region: string, clusterName: string) =>
  waitUntilGone({
    resource: `STACKIT SKE cluster ${clusterName}`,
    read: getClusterOrUndefined(projectId, region, clusterName),
    // `SKE_REMAINING_RESOURCES` shows up here and names leftovers. Nothing says
    // it's final, as the controllers may still be cleaning up, so it only
    // labels the timeout.
    state: describeClusterState,
    timeout: CLUSTER_DELETE_TIMEOUT,
    interval: "10 seconds",
    maxInterval: "30 seconds",
  });

/** Wait out an in-flight create, update, hibernation or wake-up. */
const waitForClusterSettled = (projectId: string, region: string, clusterName: string) =>
  waitFor({
    resource: `STACKIT SKE cluster ${clusterName}`,
    read: getClusterOrUndefined(projectId, region, clusterName),
    ready: (cluster) => cluster === undefined || !isClusterTransitioning(cluster),
    state: (cluster) => (cluster === undefined ? "gone" : describeClusterState(cluster)),
    timeout: CLUSTER_READY_TIMEOUT,
    interval: "10 seconds",
    maxInterval: "30 seconds",
  });

/**
 * Wait until the cluster is usable. `STATE_UNHEALTHY` can occur temporarily
 * during creation (Go SDK), so it keeps waiting, except for an invalid
 * Observability instance id, which stays impaired until the id is fixed.
 */
const waitForClusterReady = (projectId: string, region: string, clusterName: string) =>
  waitFor({
    resource: `STACKIT SKE cluster ${clusterName}`,
    // Not visible yet right after the PUT: keep polling.
    read: getClusterOrUndefined(projectId, region, clusterName),
    ready: (cluster) => cluster !== undefined && isClusterReady(cluster),
    failed: (cluster) =>
      cluster === undefined
        ? undefined
        : isDeleting(cluster)
          ? "the cluster is being deleted"
          : clusterState(cluster) === "STATE_UNHEALTHY" &&
              cluster.status?.error?.code === "SKE_OBSERVABILITY_INSTANCE_NOT_FOUND"
            ? (cluster.status.error.message ?? cluster.status.error.code)
            : undefined,
    state: (cluster) => (cluster === undefined ? "not visible" : describeClusterState(cluster)),
    timeout: CLUSTER_READY_TIMEOUT,
    interval: "10 seconds",
    maxInterval: "30 seconds",
  }).pipe(Effect.map((cluster) => cluster!));

/** Maintenance window times as the API takes them: a date-time. */
const toDateTime = (time: string) => (time.includes("T") ? time : `0000-01-01T${time}`);

/**
 * One node pool as the PUT sends it: the desired settings, with the observed
 * value for whatever the props leave to the API, so nothing unrelated changes.
 */
const toNodepool = Effect.fn(function* (
  pool: ClusterNodepool,
  observed: ske.Nodepool | undefined,
  options: ske.ProviderOptions,
) {
  const imageName = pool.imageName ?? observed?.machine.image.name ?? DEFAULT_IMAGE_NAME;
  const imageVersion = yield* requireMinimumVersion({
    what: `${imageName} image`,
    minimum: pool.imageVersion,
    current:
      observed?.machine.image.name === imageName ? observed.machine.image.version : undefined,
    offered: options.machineImages?.find((image) => image.name === imageName)?.versions ?? [],
  });
  const observedKubelet = observed?.kubernetes?.version;
  const kubeletVersion =
    pool.kubernetesVersion === undefined
      ? observedKubelet
      : yield* requireMinimumVersion({
          what: "node pool Kubernetes",
          minimum: pool.kubernetesVersion,
          current: observedKubelet,
          offered: options.kubernetesVersions ?? [],
        });
  return {
    name: pool.name,
    allowSystemComponents: pool.allowSystemComponents ?? observed?.allowSystemComponents ?? true,
    availabilityZones: [...pool.availabilityZones],
    machine: { type: pool.machineType, image: { name: imageName, version: imageVersion } },
    minimum: pool.minimum,
    maximum: pool.maximum,
    maxSurge: pool.maxSurge ?? observed?.maxSurge,
    maxUnavailable: pool.maxUnavailable ?? observed?.maxUnavailable,
    volume: {
      size: pool.volumeSize ?? observed?.volume.size ?? DEFAULT_VOLUME_SIZE,
      type: pool.volumeType ?? observed?.volume.type ?? DEFAULT_VOLUME_TYPE,
    },
    labels: pool.labels ?? observed?.labels,
    taints: pool.taints ?? observed?.taints,
    cri: pool.cri ?? observed?.cri,
    kubernetes: kubeletVersion === undefined ? undefined : { version: kubeletVersion },
  } satisfies ske.Nodepool;
});

const toHibernation = (
  hibernation: ClusterProps["hibernation"],
  observed: ske.Hibernation | undefined,
): ske.Hibernation | undefined => {
  if (hibernation === undefined) return observed;
  if (hibernation.schedules.length === 0) return undefined;
  return {
    schedules: hibernation.schedules.map((schedule) => ({
      start: schedule.start,
      end: schedule.end,
      // A schedule with no time zone stays on the one the API gave it.
      timezone:
        schedule.timezone ??
        observed?.schedules.find(
          (live) => live.start === schedule.start && live.end === schedule.end,
        )?.timezone,
    })),
  };
};

const toMaintenance = (
  maintenance: ClusterMaintenance | undefined,
  observed: ske.Maintenance | undefined,
): ske.Maintenance | undefined => {
  if (maintenance === undefined) return observed;
  const timeWindow = maintenance.timeWindow ?? observed?.timeWindow;
  return {
    autoUpdate: maintenance.autoUpdate ?? observed?.autoUpdate,
    timeWindow:
      timeWindow === undefined
        ? undefined
        : { start: toDateTime(timeWindow.start), end: toDateTime(timeWindow.end) },
  };
};

const toNetwork = (
  network: ClusterNetwork | undefined,
  observed: ske.Network | undefined,
): ske.Network | undefined => {
  const accessScope = network?.accessScope ?? observed?.controlPlane?.accessScope;
  const merged: ske.Network = {
    id: network?.id ?? observed?.id,
    controlPlane: accessScope === undefined ? undefined : { accessScope },
    podAddressRanges: network?.podAddressRanges ?? observed?.podAddressRanges,
    serviceAddressRanges: network?.serviceAddressRanges ?? observed?.serviceAddressRanges,
    cni: network?.cni ?? observed?.cni,
  };
  return Object.values(merged).every((value) => value === undefined) ? undefined : merged;
};

/**
 * The full spec for a PUT, which replaces everything it's given: desired values
 * from the props, and the observed value for anything the props leave alone.
 * Versions come back at the live value or higher, because maintenance may have
 * moved them. The server-owned `status` is never sent.
 */
const toClusterSpec = Effect.fn(function* (
  news: ClusterProps,
  observed: ske.Cluster | undefined,
  options: ske.ProviderOptions,
  labels: Record<string, string>,
) {
  const version = yield* requireMinimumVersion({
    what: "Kubernetes",
    minimum: news.kubernetesVersion,
    current: observed?.kubernetes.version,
    offered: options.kubernetesVersions ?? [],
  });
  const nodepools: ske.Nodepool[] = [];
  for (const pool of news.nodepools) {
    const live = observed?.nodepools.find((candidate) => candidate.name === pool.name);
    nodepools.push(yield* toNodepool(pool, live, options));
  }
  return {
    kubernetes: { version },
    nodepools,
    labels,
    network: toNetwork(news.network, observed?.network),
    hibernation: toHibernation(news.hibernation, observed?.hibernation),
    maintenance: toMaintenance(news.maintenance, observed?.maintenance),
    extensions: { ...observed?.extensions, ...news.extensions },
    access: news.access ?? observed?.access,
    audit: news.audit ?? observed?.audit,
  } satisfies ClusterSpec;
});

/** Whether a network setting that only a replacement can change has changed. */
const networkIdentityChanged = (
  network: ClusterNetwork | undefined,
  output: ClusterAttributes,
): boolean =>
  (network?.id !== undefined && network.id !== output.networkId) ||
  (network?.accessScope !== undefined &&
    output.accessScope !== undefined &&
    network.accessScope !== output.accessScope) ||
  (network?.podAddressRanges !== undefined &&
    !sameMembers(network.podAddressRanges, output.podAddressRanges)) ||
  (network?.serviceAddressRanges !== undefined &&
    !sameMembers(network.serviceAddressRanges, output.serviceAddressRanges));

const comparableConnection = (props: ConnectionProps | undefined) =>
  JSON.stringify(
    unwrapRedacted({
      registry: props?.registry,
      architecture: props?.architecture,
    }),
  );

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterName", "projectId", "region", "connection"],
    // A cluster runs on its network and serves its DNS zones, so it goes first.
    nuke: { dependsOn: ["Stackit.IaaS.Network", "Stackit.DNS.Zone"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const { items } = yield* ske.listClusters({
        projectId: env.projectId,
        region: env.region,
      });
      return (items ?? [])
        .filter((cluster) => isAlchemyOwned(cluster.labels) && cluster.name !== undefined)
        .map((cluster) => toAttrs(env.projectId, env.region, cluster.name!, cluster, undefined));
    }),

    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (output === undefined) return undefined;
      // An unresolved identity can resolve to the name the cluster already has,
      // and one name can't exist twice: an explicit name deletes the old cluster
      // first. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<ClusterProps>(news, ["name", "projectId", "region", "network"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ClusterProps>(news, "name") !== undefined,
        } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? env.projectId;
      const region = news.region ?? env.region;
      const clusterName = yield* resolveClusterName(id, news, output);
      const sameIdentity =
        clusterName === output.clusterName &&
        projectId === output.projectId &&
        region === output.region;
      if (!sameIdentity || networkIdentityChanged(news.network, output)) {
        // A generated name is new for every generation, so only an explicit one
        // can collide with the cluster being replaced.
        return { action: "replace", deleteFirst: sameIdentity && news.name !== undefined } as const;
      }
      // `registry` and `architecture` live on `connection`, so it isn't stable
      // while they change. Everything else takes the engine's default.
      if (comparableConnection(olds) !== comparableConnection(news)) {
        return {
          action: "update" as const,
          stables: ["clusterName", "projectId", "region"],
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const name = output?.clusterName ?? olds?.name;
      let cluster: ske.Cluster | undefined;
      if (name !== undefined) {
        cluster = yield* getClusterOrUndefined(projectId, region, name);
      } else if (previous !== undefined) {
        // Labels can't tell generations apart, and garbage collection deletes the
        // generation being replaced, so a replacement only looks for its own
        // (instance-id-bearing) name.
        const generated = yield* generatedName(id);
        cluster = yield* getClusterOrUndefined(projectId, region, generated);
      } else {
        // A crashed create or lost state: find it by its labels.
        cluster = yield* findClusterByOwnership(projectId, region, id);
      }
      if (cluster === undefined) return undefined;
      const clusterName = cluster.name ?? name;
      if (clusterName === undefined) return undefined;
      const attrs = toAttrs(projectId, region, clusterName, cluster, olds);
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it can be someone else's.
      if (
        previous?.clusterName === clusterName &&
        previous.projectId === projectId &&
        previous.region === region
      ) {
        return attrs;
      }
      return (yield* hasAlchemyLabels(id, cluster.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const clusterName = yield* resolveClusterName(id, news, output);
      const labels = yield* desiredLabels(id, news.labels);

      yield* ensureServiceEnabled({ projectId, region, serviceId: SKE_SERVICE_ID });

      // 1. Observe. Let a delete in flight finish, and a transition settle, so
      // the spec below is built from what the cluster will really be.
      let observed = yield* getClusterOrUndefined(projectId, region, clusterName);
      if (observed !== undefined && isDeleting(observed)) {
        yield* waitForClusterGone(projectId, region, clusterName);
        observed = undefined;
      }
      if (observed !== undefined && isClusterTransitioning(observed)) {
        observed = yield* waitForClusterSettled(projectId, region, clusterName);
      }

      const options = yield* ske.listProviderOptions({ region });
      const desired = yield* toClusterSpec(news, observed, options, labels);

      // 2 + 3. Ensure and sync are one PUT, a true upsert. It takes the full
      // spec, so it only runs on a real delta.
      if (observed === undefined || !sameClusterSpec(observed, desired)) {
        yield* ske.createOrUpdateCluster({ projectId, region, clusterName, ...desired });
        // The PUT returns before the status moves. Give it a moment to leave the
        // previous state, so a stale `STATE_HEALTHY` can't end the wait below.
        yield* Effect.sleep("15 seconds");
      }

      // 4. Return once the cluster is usable.
      const ready = yield* waitForClusterReady(projectId, region, clusterName);
      return toAttrs(projectId, region, clusterName, ready, news);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, region, clusterName } = output;
      const current = yield* getClusterOrUndefined(projectId, region, clusterName);
      if (current === undefined) return;
      if (!isDeleting(current)) {
        yield* ske
          .deleteCluster({ projectId, region, clusterName })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }
      yield* waitForClusterGone(projectId, region, clusterName);
    }),
  });
