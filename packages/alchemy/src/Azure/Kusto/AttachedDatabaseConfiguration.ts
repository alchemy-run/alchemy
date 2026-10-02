import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  clusterLocation,
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  sameId,
  whileClusterBusy,
} from "./common.ts";

export interface KustoTableLevelSharingProperties {
  /** Tables to include (`*` wildcards allowed). */
  tablesToInclude?: string[];
  /** Tables to exclude. */
  tablesToExclude?: string[];
  /** External tables to include. */
  externalTablesToInclude?: string[];
  /** External tables to exclude. */
  externalTablesToExclude?: string[];
  /** Materialized views to include. */
  materializedViewsToInclude?: string[];
  /** Materialized views to exclude. */
  materializedViewsToExclude?: string[];
  /** Functions to include. */
  functionsToInclude?: string[];
  /** Functions to exclude. */
  functionsToExclude?: string[];
}

export interface AttachedDatabaseConfigurationProps {
  /** Resource group of the follower cluster. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the follower cluster. Changing it replaces the configuration. */
  cluster: string;
  /**
   * Configuration name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the configuration.
   * @default the follower cluster's location
   */
  location?: string;
  /**
   * ARM resource ID of the leader cluster. Changing it replaces the
   * configuration.
   */
  leaderClusterId: string;
  /**
   * Leader database to follow, or `*` for all databases. Changing it
   * replaces the configuration.
   */
  databaseName: string;
  /**
   * Name of the follower database (single-database attach only). Changing
   * it replaces the configuration.
   */
  databaseNameOverride?: string;
  /**
   * Prefix for the follower databases' names. Changing it replaces the
   * configuration.
   */
  databaseNamePrefix?: string;
  /**
   * How principals of the leader and follower databases are combined.
   * @default "Union"
   */
  defaultPrincipalsModificationKind?: "Union" | "Replace" | "None";
  /** Restrict which tables, views, and functions are followed. */
  tableLevelSharingProperties?: KustoTableLevelSharingProperties;
}

export interface AttachedDatabaseConfiguration extends Resource<
  "Azure.Kusto.AttachedDatabaseConfiguration",
  AttachedDatabaseConfigurationProps,
  {
    /** Name of the configuration. */
    attachedDatabaseConfigurationName: string;
    /** ARM resource ID of the configuration. */
    attachedDatabaseConfigurationId: string;
    /** Follower cluster. */
    cluster: string;
    /** Resource group of the follower cluster. */
    resourceGroup: string;
    /** Leader cluster ARM ID. */
    leaderClusterId: string;
    /** Followed leader database (or `*`). */
    databaseName: string;
    /** Names of the follower databases attached by this configuration. */
    attachedDatabaseNames: string[];
    /** Principal combination mode. */
    defaultPrincipalsModificationKind: string;
  },
  never,
  Providers
> {}

/**
 * Attaches databases of a leader Azure Data Explorer (Kusto) cluster to a
 * follower cluster as read-only follower databases (the follower database
 * pattern).
 *
 * @see https://learn.microsoft.com/azure/data-explorer/follower
 *
 * ### Following a Database
 * **Example:** Follow one database from a leader cluster
 * ```typescript
 * const follow = yield* Azure.Kusto.AttachedDatabaseConfiguration("follow", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: follower.clusterName,
 *   leaderClusterId: leader.clusterId,
 *   databaseName: db.databaseName,
 *   defaultPrincipalsModificationKind: "Union",
 * });
 * ```
 *
 * @resource
 */
export const AttachedDatabaseConfiguration =
  Resource<AttachedDatabaseConfiguration>(
    "Azure.Kusto.AttachedDatabaseConfiguration",
  );

const getConfiguration = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  attachedDatabaseConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetAttachedDatabaseConfiguration({
      subscriptionId,
      resourceGroupName,
      clusterName,
      attachedDatabaseConfigurationName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  config: kusto.GetAttachedDatabaseConfigurationResponse,
): AttachedDatabaseConfiguration["Attributes"] => ({
  attachedDatabaseConfigurationName: name,
  attachedDatabaseConfigurationId: config.id ?? "",
  cluster,
  resourceGroup,
  leaderClusterId: config.properties?.clusterResourceId ?? "",
  databaseName: config.properties?.databaseName ?? "",
  attachedDatabaseNames: [...(config.properties?.attachedDatabaseNames ?? [])],
  defaultPrincipalsModificationKind:
    config.properties?.defaultPrincipalsModificationKind ?? "",
});

const normalizeSharing = (
  sharing: KustoTableLevelSharingProperties | undefined,
) =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(sharing ?? {})
        .filter(([, v]) => Array.isArray(v) && v.length > 0)
        .map(([k, v]) => [k, [...(v as string[])].sort()])
        .sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  );

export const AttachedDatabaseConfigurationProvider = () =>
  Provider.succeed(AttachedDatabaseConfiguration, {
    stables: [
      "attachedDatabaseConfigurationName",
      "attachedDatabaseConfigurationId",
      "cluster",
      "resourceGroup",
      "leaderClusterId",
      "databaseName",
    ],

    // Configurations live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        (news.name !== undefined &&
          news.name !== output.attachedDatabaseConfigurationName) ||
        !sameId(news.leaderClusterId, output.leaderClusterId) ||
        news.databaseName !== output.databaseName ||
        (olds !== undefined &&
          (news.databaseNameOverride !== olds.databaseNameOverride ||
            news.databaseNamePrefix !== olds.databaseNamePrefix ||
            (news.location !== undefined &&
              lower(news.location) !== lower(olds.location))))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.attachedDatabaseConfigurationName ??
        olds?.name ??
        (yield* createKustoChildName(id));
      const observed = yield* getConfiguration(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ??
        output?.attachedDatabaseConfigurationName ??
        (yield* createKustoChildName(id));
      const kind = news.defaultPrincipalsModificationKind ?? "Union";
      const get = getConfiguration(
        subscriptionId,
        resourceGroup,
        cluster,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT creates the configuration and updates its
      // mutable settings; skip it when observed state already matches.
      if (
        observed === undefined ||
        observed.properties?.defaultPrincipalsModificationKind !== kind ||
        (news.tableLevelSharingProperties !== undefined &&
          normalizeSharing(news.tableLevelSharingProperties) !==
            normalizeSharing(observed.properties?.tableLevelSharingProperties))
      ) {
        const location =
          news.location ??
          observed?.location ??
          (yield* clusterLocation(subscriptionId, resourceGroup, cluster));
        yield* kusto
          .AttachedDatabaseConfigurationsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            clusterName: cluster,
            attachedDatabaseConfigurationName: name,
            location,
            properties: {
              databaseName: news.databaseName,
              clusterResourceId: news.leaderClusterId,
              defaultPrincipalsModificationKind: kind,
              tableLevelSharingProperties: news.tableLevelSharingProperties,
              databaseNameOverride: news.databaseNameOverride,
              databaseNamePrefix: news.databaseNamePrefix,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      // Attaching replicates the leader's metadata; allow a few minutes.
      const fresh = yield* waitForProvisioned(
        `kusto attached database configuration ${name}`,
        get,
        (c) => c.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, cluster, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteAttachedDatabaseConfiguration({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            attachedDatabaseConfigurationName:
              output.attachedDatabaseConfigurationName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto attached database configuration ${output.attachedDatabaseConfigurationName}`,
        getConfiguration(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.attachedDatabaseConfigurationName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
