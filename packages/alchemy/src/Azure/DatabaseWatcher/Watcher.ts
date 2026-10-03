import * as databasewatcher from "@distilled.cloud/azure/databasewatcher";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type WatcherIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

export interface WatcherIdentity {
  /** Identity type. */
  type: WatcherIdentityType;
  /**
   * ARM resource IDs of user-assigned identities attached to the watcher.
   * Required when `type` includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export type KustoOfferingType = "adx" | "free" | "fabric";

export interface WatcherDatastore {
  /** ARM resource ID of the Azure Data Explorer cluster (`adx` offerings). */
  adxClusterResourceId?: string;
  /** Display name of the Kusto cluster. */
  kustoClusterDisplayName?: string;
  /** Kusto cluster URI, e.g. `https://mycluster.eastus.kusto.windows.net`. */
  kustoClusterUri: string;
  /** Kusto data ingestion URI, e.g. `https://ingest-mycluster.eastus.kusto.windows.net`. */
  kustoDataIngestionUri: string;
  /** Name of the Kusto database that receives the monitoring data. */
  kustoDatabaseName: string;
  /** Kusto management URL. */
  kustoManagementUrl: string;
  /** Kind of Kusto offering: Azure Data Explorer, ADX free cluster, or Fabric Real-Time Intelligence. */
  kustoOfferingType: KustoOfferingType;
}

export interface WatcherProps {
  /**
   * Resource group the watcher is created in. Changing it replaces the
   * watcher.
   */
  resourceGroup: string;
  /**
   * Name of the watcher: 3-60 letters, digits, and hyphens, starting with
   * a letter. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the watcher.
   */
  name?: string;
  /**
   * Azure location of the watcher. Changing it replaces the watcher.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Managed identity of the watcher. The identity needs ingest rights on
   * the Kusto database and `VIEW SERVER PERFORMANCE STATE` on the SQL
   * targets.
   * @default { type: "SystemAssigned" }
   */
  identity?: WatcherIdentity;
  /**
   * Kusto data store that receives the collected monitoring data. A
   * running watcher is stopped while its data store changes and restarted
   * afterwards.
   */
  datastore?: WatcherDatastore;
  /**
   * ARM resource ID of a user-assigned managed identity assigned to new
   * alert rules created from the watcher.
   */
  defaultAlertRuleIdentityResourceId?: string;
  /**
   * Desired monitoring state. `true` starts data collection (requires a
   * data store and at least one target), `false` stops it. When omitted,
   * the run state is left as observed.
   */
  started?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Watcher extends Resource<
  "Azure.DatabaseWatcher.Watcher",
  WatcherProps,
  {
    /** Name of the watcher. */
    watcherName: string;
    /** Resource group that holds the watcher. */
    resourceGroup: string;
    /** ARM resource ID of the watcher. */
    watcherId: string;
    /** Location of the watcher. */
    location: string;
    /** Identity type of the watcher. */
    identityType: string | undefined;
    /**
     * Object ID of the watcher's system-assigned identity. Grant it access
     * to the data store and the SQL targets.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the watcher's identity. */
    tenantId: string | undefined;
    /** Monitoring collection status (`Running`, `Stopped`, ...). */
    status: string | undefined;
    /** Provisioning state of the watcher. */
    provisioningState: string | undefined;
    /** Kusto database receiving the monitoring data, if configured. */
    kustoDatabaseName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A database watcher — a managed monitoring service that collects
 * performance telemetry from Azure SQL databases, elastic pools, and
 * managed instances into an Azure Data Explorer (Kusto) or Fabric
 * Real-Time Intelligence data store.
 *
 * The watcher itself is free; you pay for the data store and the
 * monitored SQL resources.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database-watcher-overview
 *
 * ### Creating a Watcher
 * **Example:** Watcher with a system-assigned identity
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("monitoring");
 * const watcher = yield* Azure.DatabaseWatcher.Watcher("sql-watcher", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * ### Collecting Data
 * **Example:** Watcher writing to an Azure Data Explorer database
 * ```typescript
 * const watcher = yield* Azure.DatabaseWatcher.Watcher("sql-watcher", {
 *   resourceGroup: group.resourceGroupName,
 *   datastore: {
 *     adxClusterResourceId: cluster.clusterId,
 *     kustoClusterUri: cluster.uri,
 *     kustoDataIngestionUri: cluster.dataIngestionUri,
 *     kustoManagementUrl: cluster.uri,
 *     kustoDatabaseName: database.databaseName,
 *     kustoOfferingType: "adx",
 *   },
 *   started: true,
 * });
 * ```
 *
 * @resource
 */
export const Watcher = Resource<Watcher>("Azure.DatabaseWatcher.Watcher");

type ObservedWatcher = databasewatcher.GetWatcherResponse;

const getWatcher = (
  subscriptionId: string,
  resourceGroupName: string,
  watcherName: string,
) =>
  orUndefinedIfNotFound(
    databasewatcher.GetWatcher({
      subscriptionId,
      resourceGroupName,
      watcherName,
    }),
  );

const createWatcherName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  name: string,
  watcher: ObservedWatcher,
): Watcher["Attributes"] => ({
  watcherName: name,
  resourceGroup,
  watcherId: watcher.id ?? "",
  location: watcher.location,
  identityType: watcher.identity?.type,
  principalId: watcher.identity?.principalId,
  tenantId: watcher.identity?.tenantId,
  status: watcher.properties?.status,
  provisioningState: watcher.properties?.provisioningState,
  kustoDatabaseName: watcher.properties?.datastore?.kustoDatabaseName,
  tags: userTags(watcher.tags),
});

const toIdentity = (identity: WatcherIdentity) => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities?.length
    ? Object.fromEntries(
        identity.userAssignedIdentities.map((id) => [id, {}]),
      )
    : undefined,
});

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replaceAll(" ", "").toLowerCase();

const identityDiffers = (
  observed: ObservedWatcher["identity"],
  desired: WatcherIdentity,
) => {
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((k) => k.toLowerCase())
    .sort();
  return have.join("|") !== want.join("|");
};

const datastoreDiffers = (
  observed: databasewatcher.Datastore | undefined,
  desired: WatcherDatastore,
) =>
  observed === undefined ||
  (observed.adxClusterResourceId ?? "").toLowerCase() !==
    (desired.adxClusterResourceId ?? "").toLowerCase() ||
  (desired.kustoClusterDisplayName !== undefined &&
    observed.kustoClusterDisplayName !== desired.kustoClusterDisplayName) ||
  observed.kustoClusterUri !== desired.kustoClusterUri ||
  observed.kustoDataIngestionUri !== desired.kustoDataIngestionUri ||
  observed.kustoDatabaseName !== desired.kustoDatabaseName ||
  observed.kustoManagementUrl !== desired.kustoManagementUrl ||
  observed.kustoOfferingType !== desired.kustoOfferingType;

const TRANSITIONAL = new Set(["Starting", "Stopping", "Deleting"]);

/** Wait until the watcher's run state settles (not Starting/Stopping). */
const waitForSettled = <E, R>(
  get: Effect.Effect<ObservedWatcher | undefined, E, R>,
) =>
  get.pipe(
    Effect.repeat({
      until: (w) =>
        w === undefined || !TRANSITIONAL.has(w.properties?.status ?? ""),
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );

export const WatcherProvider = () =>
  Provider.succeed(Watcher, {
    stables: ["watcherName", "resourceGroup", "watcherId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* databasewatcher
        .ListWatcherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWatcherBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((watcher) => {
        const group = resourceGroupOf(watcher.id);
        return hasAnyAlchemyTag(watcher.tags) &&
          group !== undefined &&
          watcher.name !== undefined
          ? [toAttrs(group, watcher.name, watcher)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.watcherName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.watcherName ?? olds?.name ?? (yield* createWatcherName(id));
      const observed = yield* getWatcher(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DatabaseWatcher");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.watcherName ?? (yield* createWatcherName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identity = news.identity ?? { type: "SystemAssigned" as const };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        watcherName: name,
      };
      const get = getWatcher(subscriptionId, resourceGroup, name);
      const provisioned = waitForProvisioned(
        `database watcher ${name}`,
        get,
        (w) => w.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* databasewatcher.WatchersCreateOrUpdate({
          ...where,
          location,
          tags,
          identity: toIdentity(identity),
          properties: {
            datastore: news.datastore,
            defaultAlertRuleIdentityResourceId:
              news.defaultAlertRuleIdentityResourceId,
          },
        });
      }
      observed = yield* provisioned;
      observed = (yield* waitForSettled(get)) ?? observed;

      // Sync identity, data store, alert identity, and tags via PATCH.
      const patchIdentity = identityDiffers(observed.identity, identity);
      const patchDatastore =
        news.datastore !== undefined &&
        datastoreDiffers(observed.properties?.datastore, news.datastore);
      const patchAlertIdentity =
        news.defaultAlertRuleIdentityResourceId !== undefined &&
        (
          observed.properties?.defaultAlertRuleIdentityResourceId ?? ""
        ).toLowerCase() !==
          news.defaultAlertRuleIdentityResourceId.toLowerCase();
      const patchTags = tagsDiffer(observed.tags, tags);
      const wasRunning = observed.properties?.status === "Running";

      if (patchIdentity || patchDatastore || patchAlertIdentity || patchTags) {
        // The data store cannot change while the watcher collects data.
        const mustStop = wasRunning && (patchDatastore || patchIdentity);
        if (mustStop) {
          yield* databasewatcher.StopWatcher(where);
          yield* waitForSettled(get);
        }
        yield* databasewatcher.UpdateWatcher({
          ...where,
          identity: patchIdentity ? toIdentity(identity) : undefined,
          tags: patchTags ? tags : undefined,
          properties:
            patchDatastore || patchAlertIdentity
              ? {
                  datastore: patchDatastore ? news.datastore : undefined,
                  defaultAlertRuleIdentityResourceId: patchAlertIdentity
                    ? news.defaultAlertRuleIdentityResourceId
                    : undefined,
                }
              : undefined,
        });
        observed = yield* provisioned;
        if (mustStop && news.started !== false) {
          yield* databasewatcher.StartWatcher(where);
        }
        observed = (yield* waitForSettled(get)) ?? observed;
      }

      // Sync run state.
      const status = observed.properties?.status;
      if (news.started === true && status !== "Running") {
        yield* databasewatcher.StartWatcher(where);
        observed = (yield* waitForSettled(get)) ?? observed;
      } else if (news.started === false && status === "Running") {
        yield* databasewatcher.StopWatcher(where);
        observed = (yield* waitForSettled(get)) ?? observed;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        watcherName: output.watcherName,
      };
      const get = getWatcher(
        subscriptionId,
        output.resourceGroup,
        output.watcherName,
      );
      const observed = yield* waitForSettled(get);
      if (observed?.properties?.status === "Running") {
        yield* ignoreNotFound(databasewatcher.StopWatcher(where));
        yield* waitForSettled(get);
      }
      yield* ignoreNotFound(databasewatcher.DeleteWatcher(where));
      yield* waitUntilGone(`database watcher ${output.watcherName}`, get, {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
