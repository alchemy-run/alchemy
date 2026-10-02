import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDnsName, lower } from "./common.ts";

/** Read-write listener failover behaviour. */
export interface FailoverGroupReadWriteEndpoint {
  /**
   * `Automatic` fails over after the grace period on an outage; `Manual`
   * only fails over on request.
   */
  failoverPolicy: "Manual" | "Automatic";
  /**
   * Grace period in minutes before an automatic failover with data loss
   * (required for `Automatic`, minimum 60).
   */
  failoverWithDataLossGracePeriodMinutes?: number;
}

/** Read-only listener behaviour. */
export interface FailoverGroupReadOnlyEndpoint {
  /** Whether read-only traffic fails over to the primary when the secondary is down. */
  failoverPolicy?: "Disabled" | "Enabled";
  /** ARM ID of the server that serves read-only traffic. */
  targetServer?: string;
}

export interface FailoverGroupProps {
  /** Resource group of the primary server. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the primary SQL server. Changing it replaces the group. */
  server: string;
  /**
   * Globally unique group name (the listener DNS label
   * `<name>.database.windows.net`): lowercase letters, digits, and
   * hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * ARM IDs of the partner (secondary) servers, typically in another
   * region. Changing them replaces the group.
   */
  partnerServers: string[];
  /**
   * ARM IDs of primary databases to replicate. Adding a database seeds a
   * geo-secondary on each partner server.
   * @default []
   */
  databases?: string[];
  /**
   * Read-write listener failover policy.
   * @default { failoverPolicy: "Manual" }
   */
  readWriteEndpoint?: FailoverGroupReadWriteEndpoint;
  /** Read-only listener behaviour. */
  readOnlyEndpoint?: FailoverGroupReadOnlyEndpoint;
  /**
   * Secondary type: `Geo` (readable) or `Standby` (license-free DR).
   * @default Azure's default (`Geo`)
   */
  secondaryType?: "Geo" | "Standby";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface FailoverGroup extends Resource<
  "Azure.Sql.FailoverGroup",
  FailoverGroupProps,
  {
    /** Name of the failover group. */
    failoverGroupName: string;
    /** ARM resource ID of the failover group. */
    failoverGroupId: string;
    /** Name of the primary SQL server. */
    serverName: string;
    /** Resource group of the primary server. */
    resourceGroup: string;
    /** Location of the primary server. */
    location: string | undefined;
    /** Replication role of this server in the group (`Primary`/`Secondary`). */
    replicationRole: string | undefined;
    /** Replication state, e.g. `CATCH_UP` or `SEEDING`. */
    replicationState: string | undefined;
    /** Read-write listener, e.g. `<name>.database.windows.net`. */
    readWriteListenerEndpoint: string;
    /** Read-only listener, e.g. `<name>.secondary.database.windows.net`. */
    readOnlyListenerEndpoint: string;
    /** ARM IDs of the partner servers. */
    partnerServers: string[];
    /** ARM IDs of the replicated databases. */
    databases: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure SQL auto-failover group — geo-replicates databases from a
 * primary server to partner servers behind stable read-write and
 * read-only listener endpoints.
 *
 * Deleting the group stops replication but leaves the geo-secondary
 * databases on the partner servers; delete the partner server (or the
 * secondaries) to remove them.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/failover-group-sql-db
 *
 * ### Creating a Failover Group
 * **Example:** Replicate a database to another region
 * ```typescript
 * const primary = yield* Azure.Sql.Server("primary", { ... });
 * const secondary = yield* Azure.Sql.Server("secondary", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "westus2",
 *   ...
 * });
 * const fog = yield* Azure.Sql.FailoverGroup("fog", {
 *   resourceGroup: group.resourceGroupName,
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 * });
 * // connect to fog.readWriteListenerEndpoint
 * ```
 *
 * ### Automatic Failover
 * **Example:** Fail over automatically after one hour
 * ```typescript
 * yield* Azure.Sql.FailoverGroup("fog", {
 *   resourceGroup: group.resourceGroupName,
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   readWriteEndpoint: {
 *     failoverPolicy: "Automatic",
 *     failoverWithDataLossGracePeriodMinutes: 60,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const FailoverGroup = Resource<FailoverGroup>("Azure.Sql.FailoverGroup");

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  failoverGroupName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetFailoverGroup({
      subscriptionId,
      resourceGroupName,
      serverName,
      failoverGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  group: sql.GetFailoverGroupResponse,
): FailoverGroup["Attributes"] => ({
  failoverGroupName: name,
  failoverGroupId: group.id ?? "",
  serverName,
  resourceGroup,
  location: group.location,
  replicationRole: group.properties?.replicationRole,
  replicationState: group.properties?.replicationState,
  readWriteListenerEndpoint: `${name}.database.windows.net`,
  readOnlyListenerEndpoint: `${name}.secondary.database.windows.net`,
  partnerServers: (group.properties?.partnerServers ?? []).map((p) => p.id),
  databases: group.properties?.databases ?? [],
  tags: userTags(group.tags),
});

const sameIdSet = (a: readonly string[], b: readonly string[]) => {
  const left = a.map(lower).sort();
  const right = b.map(lower).sort();
  return left.join(",") === right.join(",");
};

const readWriteDiffers = (
  observed: sql.FailoverGroupReadWriteEndpoint | undefined,
  desired: FailoverGroupReadWriteEndpoint,
) =>
  observed?.failoverPolicy !== desired.failoverPolicy ||
  (desired.failoverWithDataLossGracePeriodMinutes !== undefined &&
    observed.failoverWithDataLossGracePeriodMinutes !==
      desired.failoverWithDataLossGracePeriodMinutes);

const readOnlyDiffers = (
  observed: sql.FailoverGroupReadOnlyEndpoint | undefined,
  desired: FailoverGroupReadOnlyEndpoint,
) =>
  (desired.failoverPolicy !== undefined &&
    observed?.failoverPolicy !== desired.failoverPolicy) ||
  (desired.targetServer !== undefined &&
    lower(observed?.targetServer) !== lower(desired.targetServer));

export const FailoverGroupProvider = () =>
  Provider.succeed(FailoverGroup, {
    stables: [
      "failoverGroupName",
      "failoverGroupId",
      "serverName",
      "resourceGroup",
      "readWriteListenerEndpoint",
      "readOnlyListenerEndpoint",
    ],

    // Failover groups live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined && news.name !== output.failoverGroupName) ||
        !sameIdSet(news.partnerServers, output.partnerServers)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const name =
        output?.failoverGroupName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getGroup(
        subscriptionId,
        resourceGroup,
        serverName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name =
        news.name ?? output?.failoverGroupName ?? (yield* createDnsName(id));
      const tags = yield* desiredTags(id, news.tags);
      const readWriteEndpoint = news.readWriteEndpoint ?? {
        failoverPolicy: "Manual" as const,
      };
      const databases = news.databases ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        serverName: server,
        failoverGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, server, name);
      const waitExists = waitForProvisioned(
        `sql failover group ${name}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 120 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation that also creates the
      // group on every partner server.
      if (observed === undefined) {
        yield* sql.FailoverGroupsCreateOrUpdate({
          ...where,
          tags,
          properties: {
            readWriteEndpoint,
            readOnlyEndpoint: news.readOnlyEndpoint,
            partnerServers: news.partnerServers.map((serverId) => ({
              id: serverId,
            })),
            databases,
            secondaryType: news.secondaryType,
          },
        });
      }
      observed = yield* waitExists;

      // Sync listener policies, databases, and tags against observed state.
      const props = observed.properties;
      const changed: sql.FailoverGroupUpdatePropertiesInput = {};
      if (readWriteDiffers(props?.readWriteEndpoint, readWriteEndpoint)) {
        changed.readWriteEndpoint = readWriteEndpoint;
      }
      if (
        news.readOnlyEndpoint !== undefined &&
        readOnlyDiffers(props?.readOnlyEndpoint, news.readOnlyEndpoint)
      ) {
        changed.readOnlyEndpoint = news.readOnlyEndpoint;
      }
      if (!sameIdSet(props?.databases ?? [], databases)) {
        changed.databases = databases;
      }
      if (
        news.secondaryType !== undefined &&
        props?.secondaryType !== news.secondaryType
      ) {
        changed.secondaryType = news.secondaryType;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* sql.UpdateFailoverGroup({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitForProvisioned(
          `sql failover group ${name}`,
          get,
          (group) =>
            group.properties?.readWriteEndpoint?.failoverPolicy ===
              readWriteEndpoint.failoverPolicy &&
            sameIdSet(group.properties?.databases ?? [], databases) &&
            !tagsDiffer(group.tags, tags)
              ? "Succeeded"
              : "Updating",
          { interval: "5 seconds", times: 120 },
        );
      }

      return toAttrs(resourceGroup, server, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteFailoverGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          failoverGroupName: output.failoverGroupName,
        }),
      );
      yield* waitUntilGone(
        `sql failover group ${output.failoverGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.failoverGroupName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
