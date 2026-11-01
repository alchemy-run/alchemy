import type { Connection, ContainerRegistry } from "@alchemy.run/kubernetes/Connection";
import * as ske from "@distilled.cloud/stackit/ske";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** Service id the SKE API needs enabled per project. */
export const SKE_SERVICE_ID = "cloud.stackit.ske";

/** Longest cluster name the API accepts. */
export const MAX_CLUSTER_NAME_LENGTH = 11;

/** Create and update budget, from the Go SDK's `CreateClusterWaitHandler`. */
export const CLUSTER_READY_TIMEOUT = "45 minutes";

/**
 * Delete budget, from the Go SDK's `DeleteClusterWaitHandler` ("aligned with
 * the service team").
 */
export const CLUSTER_DELETE_TIMEOUT = "90 minutes";

/** A version the cluster needs isn't offered by `listProviderOptions`. */
export class SkeVersionNotAvailable extends Data.TaggedError("Stackit.SKE.VersionNotAvailable")<{
  readonly what: string;
  readonly requested: string | undefined;
  readonly available: readonly string[];
  readonly message: string;
}> {}

/** `GetCluster`; `undefined` when the typed `NotFound` says it's missing. */
export const getClusterOrUndefined = (projectId: string, region: string, clusterName: string) =>
  ske
    .getCluster({ projectId, region, clusterName })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** The cluster's aggregated state. */
export const clusterState = (cluster: ske.Cluster): string | undefined =>
  cluster.status?.aggregated;

/**
 * States the Go SDK keeps waiting on. Unknown states count as not settled in
 * {@link isClusterReady}, so a new state keeps a deploy waiting, not failing.
 */
const TRANSITIONAL_STATES: ReadonlySet<string> = /*@__PURE__*/ new Set([
  "STATE_CREATING",
  "STATE_RECONCILING",
  "STATE_HIBERNATING",
  "STATE_WAKINGUP",
]);

/** A create, update, hibernation or wake-up is in flight. */
export const isClusterTransitioning = (cluster: ske.Cluster): boolean => {
  const state = clusterState(cluster);
  return state !== undefined && TRANSITIONAL_STATES.has(state);
};

/** The states the Go SDK's create and update waiter finishes on. */
export const isClusterReady = (cluster: ske.Cluster): boolean => {
  const state = clusterState(cluster);
  return state === "STATE_HEALTHY" || state === "STATE_HIBERNATED";
};

/** A short state label naming the runtime errors, for wait errors and logs. */
export const describeClusterState = (cluster: ske.Cluster): string => {
  const codes = [
    cluster.status?.error?.code,
    ...(cluster.status?.errors ?? []).map((error) => error.code),
  ].filter((code): code is string => code !== undefined);
  const state = clusterState(cluster) ?? "UNKNOWN";
  return codes.length === 0 ? state : `${state} (${[...new Set(codes)].join(", ")})`;
};

/** The numeric parts of a version; parsing stops at the first non-numeric part. */
const versionParts = (version: string): number[] => {
  const parts: number[] = [];
  for (const part of version.replace(/^v/, "").split(".")) {
    const number = Number.parseInt(part, 10);
    if (Number.isNaN(number)) break;
    parts.push(number);
  }
  return parts;
};

/** Numeric, part by part; a missing part counts as 0. Negative when `a < b`. */
export const compareVersions = (a: string, b: string): number => {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** `1.31.4` matches `1.31` and `1.31.4`, not `1.3` or `1.31.5`. */
const matchesVersion = (version: string, wanted: string): boolean => {
  const have = versionParts(version);
  return versionParts(wanted).every((part, index) => have[index] === part);
};

/** A version offered by `listProviderOptions`. */
export interface OfferedVersion {
  readonly version?: string | undefined;
  readonly state?: string | undefined;
}

const offeredVersions = (offered: readonly OfferedVersion[]) =>
  offered
    .filter(
      (entry): entry is { version: string; state?: string | undefined } =>
        entry.version !== undefined && entry.version !== "",
    )
    .sort((a, b) => compareVersions(b.version, a.version));

/**
 * The version to send, as Terraform's `kubernetes_version_min` and
 * `os_version_min` choose it:
 *
 * - a live version at or above the minimum stays: maintenance may have upgraded
 *   it, and the API prohibits downgrades;
 * - otherwise the newest offered version matching the minimum, preferring a
 *   supported one over a preview;
 * - no minimum keeps the live version, or takes the newest supported one.
 *
 * `undefined` when nothing qualifies.
 */
export const resolveMinimumVersion = (options: {
  readonly minimum: string | undefined;
  readonly current: string | undefined;
  readonly offered: readonly OfferedVersion[];
}): string | undefined => {
  const { minimum, current } = options;
  const offered = offeredVersions(options.offered);
  if (minimum === undefined) {
    return current ?? offered.find((entry) => entry.state === "supported")?.version;
  }
  if (current !== undefined && compareVersions(current, minimum) >= 0) return current;
  const matching = offered.filter((entry) => matchesVersion(entry.version, minimum));
  const newest = matching[0];
  return newest?.state === "preview"
    ? (matching.find((entry) => entry.state === "supported") ?? newest).version
    : newest?.version;
};

/**
 * {@link resolveMinimumVersion}, failing with {@link SkeVersionNotAvailable}
 * when nothing qualifies.
 */
export const requireMinimumVersion = (options: {
  readonly what: string;
  readonly minimum: string | undefined;
  readonly current: string | undefined;
  readonly offered: readonly OfferedVersion[];
}): Effect.Effect<string, SkeVersionNotAvailable> => {
  const version = resolveMinimumVersion(options);
  if (version !== undefined) return Effect.succeed(version);
  const available = offeredVersions(options.offered).map((entry) => entry.version);
  return Effect.fail(
    new SkeVersionNotAvailable({
      what: options.what,
      requested: options.minimum,
      available,
      message:
        `No ${options.what} version matches ${options.minimum ?? "the latest supported"}. ` +
        `Available: ${available.join(", ") || "none"}`,
    }),
  );
};

/** Sorted keys, sorted arrays, no `undefined`, empty arrays or empty objects. */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    if (items.length === 0) return undefined;
    return items
      .map((item) => ({ item, key: JSON.stringify(item) }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ item }) => item);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .map(([key, entry]) => [key, canonical(entry)] as const)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  }
  return value;
};

/**
 * The time of day of a maintenance window bound. The API takes a date-time, but
 * only the time means anything: Terraform sends the year-zero date of a parsed
 * `15:04:05Z07:00`.
 */
export const timeOfDay = (time: string): string =>
  (time.includes("T") ? time.slice(time.indexOf("T") + 1) : time).replace(/[+-]00:00$/, "Z");

/** The parts of a cluster a PUT sets: a cluster's spec, without its status. */
export type ClusterSpec = Pick<
  ske.CreateOrUpdateClusterRequest,
  | "access"
  | "audit"
  | "extensions"
  | "hibernation"
  | "kubernetes"
  | "labels"
  | "maintenance"
  | "network"
  | "nodepools"
>;

const comparableSpec = (spec: ClusterSpec): string =>
  JSON.stringify(
    canonical({
      access: spec.access,
      audit: spec.audit,
      extensions: spec.extensions,
      hibernation: spec.hibernation,
      kubernetes: spec.kubernetes,
      labels: spec.labels,
      maintenance:
        spec.maintenance === undefined
          ? undefined
          : {
              autoUpdate: spec.maintenance.autoUpdate,
              timeWindow:
                spec.maintenance.timeWindow === undefined
                  ? undefined
                  : {
                      start: timeOfDay(spec.maintenance.timeWindow.start),
                      end: timeOfDay(spec.maintenance.timeWindow.end),
                    },
            },
      network: spec.network,
      nodepools: spec.nodepools,
    }),
  );

/**
 * Whether two specs ask for the same cluster. Order doesn't count, nor does an
 * empty value against an absent one, so an untouched cluster skips the PUT.
 */
export const sameClusterSpec = (a: ClusterSpec, b: ClusterSpec): boolean =>
  comparableSpec(a) === comparableSpec(b);

/**
 * The `Kubernetes.Connection` of an SKE cluster, stamped on
 * `Stackit.SKE.Cluster` attributes so the cluster resource can be passed
 * directly as any `Kubernetes.*` workload's `cluster`. It holds no credentials:
 * the adapter mints those per connection.
 */
export const skeConnectionOf = (options: {
  readonly clusterName: string;
  readonly projectId: string;
  readonly region: string;
  readonly registry?: ContainerRegistry | undefined;
  readonly architecture?: "amd64" | "arm64" | undefined;
}): Connection => ({
  auth: {
    kind: "stackit-ske",
    clusterName: options.clusterName,
    projectId: options.projectId,
    region: options.region,
  },
  ...(options.registry !== undefined ? { registry: options.registry } : {}),
  ...(options.architecture !== undefined ? { architecture: options.architecture } : {}),
});

/** When a cluster's credentials last stopped being valid: its rebirth or rotation. */
const credentialCutoffs = (cluster: ske.Cluster): readonly string[] =>
  [cluster.status?.creationTime, cluster.status?.credentialsRotation?.lastCompletionTime].filter(
    (time): time is string => time !== undefined,
  );

const timeOf = (time: string): number => new Date(time).getTime();

/**
 * Whether a kubeconfig minted at `mintedAt` predates what the cluster accepts:
 * the cluster was recreated, or a credentials rotation completed, after it was
 * minted. It reads as valid by its timestamp and still fails against the API.
 */
export const isCredentialRevoked = (mintedAt: string, cluster: ske.Cluster): boolean =>
  credentialCutoffs(cluster).some((cutoff) => timeOf(mintedAt) < timeOf(cutoff));

/** Whether a kubeconfig is expired, or within `refreshBeforeSeconds` of it. */
export const isCredentialExpiring = (options: {
  readonly expirationTimestamp: string;
  readonly refreshBeforeSeconds: number;
  readonly now: number;
}): boolean =>
  options.now >= timeOf(options.expirationTimestamp) - options.refreshBeforeSeconds * 1000;

/**
 * The instant a kubeconfig was minted, by the API's clock: its expiry minus the
 * TTL we asked for. Comparing it with the cluster's server-side timestamps stays
 * correct when the deployer's clock is off.
 */
export const mintedAtOf = (expirationTimestamp: string, expirationSeconds: number): string =>
  new Date(timeOf(expirationTimestamp) - expirationSeconds * 1000).toISOString();
