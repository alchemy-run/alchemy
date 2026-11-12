import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Cluster as ClusterShape } from "@distilled.cloud/starburst-galaxy/cluster";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  changedFields,
  collectAll,
  findFirst,
  hasChanges,
  ownership,
  physicalName,
  sameIds,
  CLUSTER_NAME,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

/** How long a cluster idles before Galaxy suspends it. */
export type ClusterAutoSuspend =
  | "1 minute"
  | "5 minutes"
  | "15 minutes"
  | "30 minutes"
  | "1 hour"
  | "never";

export interface ClusterProps {
  /**
   * Cluster name: lowercase letters, digits and `-`, at most 30 characters.
   * It is part of the cluster's Trino host name. Renaming updates the
   * cluster in place and changes its `trinoUri`; Galaxy renames only a
   * disabled cluster, so an enabled one is disabled for the rename and
   * enabled again.
   * @default generated from the stack, logical id and stage (lowercase, `-`-delimited)
   */
  readonly name?: string;
  /**
   * Galaxy cloud region the cluster runs in, e.g. `"aws-us-east1"`. A
   * cluster can only query object-storage catalogs in its own region.
   */
  readonly cloudRegionId: string;
  /**
   * IDs of the catalogs the cluster can query (each catalog resource's
   * `catalogId`). Order does not matter.
   * @default []
   */
  readonly catalogs?: ReadonlyArray<string>;
  /**
   * Minimum worker count. The free plan runs single-node clusters (`1`).
   * @default 1
   */
  readonly minWorkers?: number;
  /**
   * Maximum worker count; Galaxy scales between `minWorkers` and this.
   * @default minWorkers
   */
  readonly maxWorkers?: number;
  /** Query processing mode: Galaxy's default, `"Batch"` (fault-tolerant execution) or `"WarpSpeed"`. */
  readonly processingMode?: "Batch" | "WarpSpeed";
  /**
   * Whether the cluster may run. A disabled cluster keeps its configuration,
   * refuses queries and costs nothing. An enabled cluster that idles for
   * `autoSuspend` is suspended by Galaxy and resumes on the next query; a
   * suspended cluster is enabled, and Alchemy never treats running versus
   * suspended as drift.
   * @default true
   */
  readonly enabled?: boolean;
  /**
   * How long the cluster idles before Galaxy suspends it; the next query
   * resumes it, which takes one to five minutes. Free clusters accept
   * `"1 minute"` and `"5 minutes"` only. `"never"` keeps the cluster
   * running (paid plans); Galaxy cannot clear the setting in place, so
   * switching an existing cluster to `"never"` replaces it.
   * @default "5 minutes"
   */
  readonly autoSuspend?: ClusterAutoSuspend;
  /**
   * Galaxy's result cache: `true` with Galaxy's default visibility, or the
   * number of seconds a cached result stays visible.
   * @default false
   */
  readonly resultCache?: boolean | { readonly visibilitySeconds: number };
  /**
   * Run the cluster behind AWS PrivateLink.
   * @default false
   */
  readonly privateLink?: boolean;
  /** Number of cluster replicas, where the plan offers them. */
  readonly replicas?: number;
}

/** Galaxy's cluster states, normalised. Unknown strings are kept, never guessed into a known one. */
export type ClusterState =
  | { readonly _tag: "NotEnabled" }
  | { readonly _tag: "Enabled" }
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Suspended" }
  | { readonly _tag: "Other"; readonly raw: string };

export interface ClusterAttributes {
  /** Galaxy's cluster ID (`w-…`). */
  readonly clusterId: string;
  /** Cluster name. */
  readonly name: string;
  /** Galaxy cloud region. */
  readonly cloudRegionId: string;
  /**
   * Trino's URL for clients (JDBC, the Trino CLI, `Export.Trino.engine`).
   * Galaxy reports it once the cluster has been enabled.
   */
  readonly trinoUri: string | undefined;
  /** Whether the cluster may run. */
  readonly enabled: boolean;
  /** Galaxy's runtime state when last observed; informative, never drift. */
  readonly state: ClusterState;
  /** Idle minutes before Galaxy suspends the cluster; `undefined` when it never suspends. */
  readonly idleStopMinutes: number | undefined;
  /** IDs of the attached catalogs. */
  readonly catalogs: ReadonlyArray<string>;
  /** Minimum worker count. */
  readonly minWorkers: number;
  /** Maximum worker count. */
  readonly maxWorkers: number;
  /** Query processing mode. */
  readonly processingMode: "Batch" | "WarpSpeed" | undefined;
  /** Whether the result cache is on. */
  readonly resultCacheEnabled: boolean;
  /** Result cache visibility in seconds, when set. */
  readonly resultCacheDefaultVisibilitySeconds: number | undefined;
  /** Whether the cluster runs behind PrivateLink. */
  readonly privateLink: boolean;
  /** Number of replicas, when set. */
  readonly replicas: number | undefined;
  /** Whether the cluster supports resource-intensive (batch) processing. */
  readonly batchCluster: boolean;
  /** Whether the cluster supports Warp Speed. */
  readonly warpSpeedCluster: boolean;
}

/** Find a cluster this stack doesn't manage by its name. */
export interface ClusterLookup {
  /** Cluster name. */
  readonly name: string;
}

export type Cluster = Resource<
  "StarburstGalaxy.Cluster",
  ClusterProps,
  ClusterAttributes,
  never,
  Providers,
  ClusterLookup
>;

/**
 * A Starburst Galaxy cluster: the Trino compute that queries the catalogs
 * attached to it, reached at `trinoUri`.
 *
 * Alchemy owns the desired state, whether the cluster is `enabled` and how
 * soon it auto-suspends. Galaxy owns the runtime state: an enabled
 * cluster starts, runs, and is suspended when it idles for `autoSuspend`,
 * and the next query resumes it. A deploy waits only until Galaxy reports
 * the enable or disable (at most 90 seconds), never for a cold start, and
 * reports the observed `state` without treating running versus suspended
 * as drift.
 *
 * Every setting updates in place, the name and region included; Galaxy
 * applies changes to a running cluster at its next query. Galaxy clusters
 * have no labels or tags: a cluster Alchemy created is recognized by its
 * generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/clusters/index.html
 *
 * ### Creating a cluster
 * **Example:** A free-size cluster over a PostgreSQL catalog
 * ```typescript
 * const project = yield* Neon.Project("app");
 * const pg = yield* StarburstGalaxy.PostgresqlCatalog("App", {
 *   endpoint: project.origin.host,
 *   databaseName: project.origin.database,
 *   username: project.origin.user,
 *   password: project.origin.password,
 * });
 * const cluster = yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   catalogs: [pg.catalogId],
 * });
 * // cluster.trinoUri is the Trino endpoint for JDBC, the CLI or Export.Trino.engine.
 * ```
 *
 * ### Starting, stopping and idling
 * **Example:** Keep the configuration but refuse queries and cost nothing
 * ```typescript
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   enabled: false,
 * });
 * ```
 *
 * **Example:** Suspend after a minute of idleness
 * ```typescript
 * yield* StarburstGalaxy.Cluster("Analytics", {
 *   cloudRegionId: "aws-us-east1",
 *   autoSuspend: "1 minute",
 * });
 * ```
 *
 * ### Sizing and processing
 * **Example:** An autoscaling cluster with fault-tolerant execution and a result cache
 * ```typescript
 * yield* StarburstGalaxy.Cluster("Etl", {
 *   cloudRegionId: "aws-us-east1",
 *   minWorkers: 2,
 *   maxWorkers: 8,
 *   processingMode: "Batch",
 *   autoSuspend: "30 minutes",
 *   resultCache: { visibilitySeconds: 3600 },
 * });
 * ```
 *
 * ### Granting use of a cluster
 * **Example:** Let a role run queries on the cluster
 * ```typescript
 * const cluster = yield* StarburstGalaxy.Cluster("Analytics", { cloudRegionId: "aws-us-east1" });
 * const analysts = yield* StarburstGalaxy.Role("Analysts", {});
 * yield* StarburstGalaxy.RolePrivilege("AnalystsUseCluster", {
 *   role: analysts.roleId,
 *   privilege: "UseCluster",
 *   entity: { kind: "Cluster", clusterId: cluster.clusterId },
 * });
 * ```
 *
 * ### Looking up an existing cluster
 * **Example:** Reference a cluster created in the Galaxy console
 * ```typescript
 * const shared = StarburstGalaxy.Cluster.lookup({ name: "shared" });
 * ```
 *
 * @resource
 * @product Clusters
 */
export const Cluster = Resource<Cluster>("StarburstGalaxy.Cluster");

/** A cluster that never settled into the state an enable or disable asked for. */
export class ClusterTransitionTimedOut extends Data.TaggedError(
  "StarburstGalaxy.ClusterTransitionTimedOut",
)<{
  readonly clusterName: string;
  readonly wanted: "enabled" | "disabled";
  readonly lastState: string;
}> {
  override get message() {
    return `Cluster ${this.clusterName} did not become ${this.wanted} within 90 seconds (last state: ${this.lastState || "unknown"})`;
  }
}

/** Galaxy reports the cluster in a state it cannot leave on its own. */
export class ClusterFailed extends Data.TaggedError("StarburstGalaxy.ClusterFailed")<{
  readonly clusterName: string;
  readonly state: string;
}> {
  override get message() {
    return `Cluster ${this.clusterName} is ${this.state}`;
  }
}

/** Galaxy accepted a cluster create but the cluster could not be read back. */
export class ClusterNotResolved extends Data.TaggedError("StarburstGalaxy.ClusterNotResolved")<{
  readonly clusterName: string;
}> {
  override get message() {
    return `Cluster ${this.clusterName} could not be found after it was created`;
  }
}

/** States Galaxy's own Terraform provider treats as unable to reach `RUNNING`. */
const FAILED_STATES: Record<string, true> = {
  FAILED: true,
  ERROR: true,
  TERMINATED: true,
  TERMINATING: true,
};

/** Galaxy's upper-case state string (`RUNNING`, `SUSPENDED`, `DISABLED`, …), normalised. */
export const clusterStateOf = (raw: string | undefined): ClusterState => {
  const key = (raw ?? "").toUpperCase().replace(/[\s-]/g, "_");
  return key === "DISABLED" || key === "NOT_ENABLED"
    ? { _tag: "NotEnabled" }
    : key === "ENABLED"
      ? { _tag: "Enabled" }
      : key === "STARTING"
        ? { _tag: "Starting" }
        : key === "RUNNING"
          ? { _tag: "Running" }
          : key === "SUSPENDED"
            ? { _tag: "Suspended" }
            : { _tag: "Other", raw: raw ?? "" };
};

const IDLE_STOP_MINUTES = {
  "1 minute": 1,
  "5 minutes": 5,
  "15 minutes": 15,
  "30 minutes": 30,
  "1 hour": 60,
  never: undefined,
} as const satisfies Record<ClusterAutoSuspend, number | undefined>;

/**
 * Whether the cluster is enabled. Galaxy's responses carry no `enabled`
 * field, even with `extended=true` (live calls, 2026-11-12): a cluster is
 * disabled exactly when its state is `DISABLED`.
 */
const enabledOf = (cluster: ClusterShape) =>
  cluster.enabled ?? clusterStateOf(cluster.clusterState)._tag !== "NotEnabled";

const toAttributes = (cluster: ClusterShape): ClusterAttributes => ({
  clusterId: cluster.clusterId,
  name: cluster.name,
  cloudRegionId: cluster.cloudRegionId,
  trinoUri: cluster.trinoUri,
  enabled: enabledOf(cluster),
  state: clusterStateOf(cluster.clusterState),
  idleStopMinutes: cluster.idleStopMinutes,
  catalogs: cluster.catalogRefs,
  minWorkers: cluster.minWorkers,
  maxWorkers: cluster.maxWorkers,
  processingMode: cluster.processingMode,
  resultCacheEnabled: cluster.resultCacheEnabled ?? false,
  resultCacheDefaultVisibilitySeconds: cluster.resultCacheDefaultVisibilitySeconds,
  privateLink: cluster.privateLinkCluster ?? false,
  replicas: cluster.replicas,
  batchCluster: cluster.batchCluster,
  warpSpeedCluster: cluster.warpSpeedCluster,
});

/** The desired configuration, as Galaxy names it. `enabled` is synced separately. */
const settingsOf = (name: string, props: ClusterProps) => {
  const minWorkers = props.minWorkers ?? 1;
  return {
    name,
    cloudRegionId: props.cloudRegionId,
    catalogRefs: [...(props.catalogs ?? [])],
    minWorkers,
    maxWorkers: props.maxWorkers ?? minWorkers,
    processingMode: props.processingMode,
    idleStopMinutes: IDLE_STOP_MINUTES[props.autoSuspend ?? "5 minutes"],
    resultCacheEnabled: props.resultCache !== undefined && props.resultCache !== false,
    resultCacheDefaultVisibilitySeconds:
      typeof props.resultCache === "object" ? props.resultCache.visibilitySeconds : undefined,
    privateLinkCluster: props.privateLink ?? false,
    replicas: props.replicas,
  };
};

/** Read a cluster with the extended fields (`processingMode`, the result cache). */
const getCluster = (clusterId: string) =>
  galaxy.cluster
    .getCluster({ clusterId, extended: true })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(
    galaxy.cluster.listClusters.items({ extended: true }),
    (cluster) => cluster.name === name,
  );

/** By id when one is known, else by name. */
const observe = Effect.fn(function* (clusterId: string | undefined, name: string) {
  if (clusterId !== undefined) {
    const byId = yield* getCluster(clusterId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

class NotSettled extends Data.TaggedError("StarburstGalaxy.ClusterNotSettled")<{
  readonly cluster: ClusterShape;
}> {}

/**
 * Wait until Galaxy reflects `enabled`. Enabled means any state but
 * `DISABLED`: a suspended cluster resumes on the next query, so the one to
 * five minutes of a cold start are never waited on. Disabled means
 * `DISABLED`, past any `STOPPING`. Bounded at 90 seconds (3-second polls).
 */
const settled = Effect.fn(function* (
  clusterId: string,
  name: string,
  enabled: boolean,
  session: ScopedPlanStatusSession,
) {
  yield* session.note(`Waiting for cluster ${name} to be ${enabled ? "enabled" : "disabled"}...`);
  return yield* galaxy.cluster.getCluster({ clusterId, extended: true }).pipe(
    Effect.flatMap((cluster): Effect.Effect<ClusterShape, ClusterFailed | NotSettled> => {
      if (FAILED_STATES[(cluster.clusterState ?? "").toUpperCase()]) {
        return Effect.fail(
          new ClusterFailed({ clusterName: name, state: cluster.clusterState ?? "" }),
        );
      }
      const done =
        enabledOf(cluster) === enabled && clusterStateOf(cluster.clusterState)._tag !== "Other";
      return done ? Effect.succeed(cluster) : Effect.fail(new NotSettled({ cluster }));
    }),
    Effect.retry({
      while: (error) => error._tag === "StarburstGalaxy.ClusterNotSettled",
      schedule: Schedule.spaced("3 seconds"),
      times: 30,
    }),
    Effect.catchTag("StarburstGalaxy.ClusterNotSettled", ({ cluster }) =>
      Effect.fail(
        new ClusterTransitionTimedOut({
          clusterName: name,
          wanted: enabled ? "enabled" : "disabled",
          lastState: cluster.clusterState ?? "",
        }),
      ),
    ),
  );
});

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["clusterId"],

    nuke: {
      // A cluster references catalogs by id; delete clusters before them.
      dependsOn: ["StarburstGalaxy.*Catalog"],
    },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      // Galaxy cannot clear the idle timeout in place: "never" is a fresh cluster.
      const suspendsNow = (olds.autoSuspend ?? "5 minutes") !== "never";
      if (news.autoSuspend === "never" && suspendsNow) {
        const deleteFirst = news.name !== undefined && news.name === (output?.name ?? olds.name);
        return { action: "replace", deleteFirst } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, CLUSTER_NAME));
      const cluster = yield* observe(output?.clusterId, name);
      if (cluster === undefined) return undefined;
      return ownership(toAttributes(cluster), {
        output,
        explicitName: olds?.name,
        previous,
        key: "clusterId",
      });
    }),

    lookup: Effect.fn(function* ({ name }) {
      const cluster = yield* findByName(name);
      return cluster === undefined ? undefined : toAttributes(cluster);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, CLUSTER_NAME);
      const enabled = news.enabled ?? true;
      const desired = settingsOf(name, news);

      // Observe: by id, else by name (absorbs a lost create).
      let cluster = yield* observe(output?.clusterId, name);

      // Ensure: Galaxy creates clusters disabled; `enabled` is synced below.
      if (cluster === undefined) {
        yield* session.note(`Creating cluster ${name}...`);
        const created = yield* galaxy.cluster
          .createCluster({
            ...desired,
            // Required by the request schema; Galaxy ignores it (its Terraform provider sends false).
            warpResiliencyEnabled: false,
            extended: true,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        cluster = created ?? (yield* findByName(name));
      }
      if (cluster === undefined) {
        return yield* new ClusterNotResolved({ clusterName: name });
      }

      // Galaxy renames only a disabled cluster (409 "Cannot change the name of a
      // cluster that is enabled"): disable first; the sync below re-enables it.
      if (cluster.name !== name && enabledOf(cluster)) {
        yield* session.note(`Disabling cluster ${cluster.name} to rename it to ${name}...`);
        const disabling = yield* galaxy.cluster.updateCluster({
          clusterId: cluster.clusterId,
          enabled: false,
          extended: true,
        });
        cluster =
          enabledOf(disabling) || clusterStateOf(disabling.clusterState)._tag === "Other"
            ? yield* settled(disabling.clusterId, cluster.name, false, session)
            : disabling;
      }

      // Sync: PATCH what differs from what Galaxy reports, `enabled` included.
      const delta = changedFields(
        {
          ...cluster,
          resultCacheEnabled: cluster.resultCacheEnabled ?? false,
          privateLinkCluster: cluster.privateLinkCluster ?? false,
        },
        desired,
      );
      if (sameIds(cluster.catalogRefs, desired.catalogRefs)) delete delta.catalogRefs;
      // Turning the cache off needs the stored visibility cleared with `null`.
      const clearVisibility =
        !desired.resultCacheEnabled && cluster.resultCacheDefaultVisibilitySeconds !== undefined;
      const toggles = enabledOf(cluster) !== enabled;
      if (hasChanges(delta) || clearVisibility || toggles) {
        yield* session.note(`Updating cluster ${name}...`);
        cluster = yield* galaxy.cluster.updateCluster({
          ...delta,
          ...(clearVisibility ? { resultCacheDefaultVisibilitySeconds: null } : {}),
          ...(toggles ? { enabled } : {}),
          clusterId: cluster.clusterId,
          extended: true,
        });
      }

      // Wait only for an enable or disable to register, never for a cold start.
      const unsettled =
        enabledOf(cluster) !== enabled || clusterStateOf(cluster.clusterState)._tag === "Other";
      if (unsettled) {
        cluster = yield* settled(cluster.clusterId, name, enabled, session);
      }

      return toAttributes(cluster);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.cluster
        .deleteCluster({ clusterId: output.clusterId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      // Gone means `getCluster` answers NotFound; a cluster still listed is reported, not forgotten.
      const lingering = yield* getCluster(output.clusterId).pipe(
        Effect.repeat({
          until: (cluster) => cluster === undefined,
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
      );
      if (lingering !== undefined) {
        return yield* new Provider.DeleteInProgress({
          message: `Cluster ${output.name} is still being deleted (state: ${lingering.clusterState ?? "unknown"})`,
        });
      }
    }),

    list: () => collectAll(galaxy.cluster.listClusters.items({ extended: true }), toAttributes),
  });
