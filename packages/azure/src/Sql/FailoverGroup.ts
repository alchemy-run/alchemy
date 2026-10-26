import * as sql from "@distilled.cloud/azure/sql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
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
import { GroupedResource } from "../StackResourceGroup.ts";
import { createDnsName, lower } from "./common.ts";

/** Read-write listener failover behaviour. */
export interface FailoverGroupReadWriteEndpoint {
  /**
   * `Automatic` fails over after the grace period on an outage; `Manual`
   * fails over only on request.
   */
  failoverPolicy: "Manual" | "Automatic";
  /**
   * Grace period in minutes before an automatic failover with data loss.
   * Required for `Automatic`; minimum 60.
   * @default none
   */
  failoverWithDataLossGracePeriodMinutes?: number;
}

/** Read-only listener behaviour. */
export interface FailoverGroupReadOnlyEndpoint {
  /**
   * Whether read-only traffic fails over to the primary when the secondary
   * is down.
   * @default Azure's default (`Disabled`)
   */
  failoverPolicy?: "Disabled" | "Enabled";
  /**
   * ARM ID of the server that serves read-only traffic.
   * @default Azure's default (a partner server)
   */
  targetServer?: string;
}

export interface FailoverGroupProps {
  /**
   * Resource group of the primary server.
   *
   * :::caution
   * Changing it replaces the group.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the primary `Azure.Sql.Server`.
   *
   * :::caution
   * Changing it replaces the group.
   * :::
   */
  server: string;
  /**
   * Globally unique group name (the listener DNS label
   * `<name>.database.windows.net`): lowercase letters, digits, and
   * hyphens.
   *
   * :::caution
   * Changing it replaces the group, and clients must use the new listener.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * ARM IDs of the partner (secondary) servers, typically in another
   * region.
   *
   * :::caution
   * Changing them replaces the group.
   * :::
   */
  partnerServers: string[];
  /**
   * ARM IDs of primary databases to replicate. Adding a database seeds a
   * geo-secondary on each partner server; removing one stops its
   * replication. Changes happen in place.
   * @default []
   */
  databases?: string[];
  /**
   * Read-write listener failover policy.
   * @default { failoverPolicy: "Manual" }
   */
  readWriteEndpoint?: FailoverGroupReadWriteEndpoint;
  /**
   * Read-only listener behaviour.
   * @default Azure's default
   */
  readOnlyEndpoint?: FailoverGroupReadOnlyEndpoint;
  /**
   * Secondary type: `Geo` (readable) or `Standby` (license-free disaster
   * recovery replica).
   * @default Azure's default (`Geo`)
   */
  secondaryType?: "Geo" | "Standby";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
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
 * An Azure SQL auto-failover group (`Microsoft.Sql/servers/failoverGroups`):
 * it geo-replicates databases from a primary server to partner servers
 * behind stable read-write and read-only listener endpoints. Clients
 * connect to the listener, so a failover needs no connection-string change.
 *
 * :::caution[Changing `name`, `server`, `partnerServers`, or `resourceGroup` replaces the group]
 * Replication seeds again on the new group. A new `name` also gives the
 * group a new listener host name, so clients must change it.
 * :::
 *
 * :::caution[Deleting the group keeps the geo-secondaries]
 * Destroying the group stops replication but leaves the geo-secondary
 * databases on the partner servers. Delete the partner server, or the
 * secondaries, to remove them.
 * :::
 *
 * See [Failover groups overview](https://learn.microsoft.com/azure/azure-sql/database/failover-group-sql-db).
 *
 * ### Creating a Failover Group
 * **Example:** Replicate a database to another region
 * ```typescript
 * const primary = yield* Azure.Sql.Server("SqlEast", {
 *   location: "eastus2",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * const secondary = yield* Azure.Sql.Server("SqlWest", {
 *   location: "westus2",
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 * });
 * const db = yield* Azure.Sql.Database("Orders", {
 *   server: primary.serverName,
 *   sku: { name: "S0" },
 * });
 * const group = yield* Azure.Sql.FailoverGroup("Orders", {
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 * });
 * // clients connect to group.readWriteListenerEndpoint
 * ```
 *
 * ### Automatic Failover
 * **Example:** Fail over automatically after one hour
 * ```typescript
 * yield* Azure.Sql.FailoverGroup("Orders", {
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 *   readWriteEndpoint: {
 *     failoverPolicy: "Automatic",
 *     failoverWithDataLossGracePeriodMinutes: 60,
 *   },
 * });
 * ```
 *
 * ### Read-Only Routing
 * **Example:** Send read-only traffic to the secondary
 * ```typescript
 * const group = yield* Azure.Sql.FailoverGroup("Orders", {
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 *   readOnlyEndpoint: { failoverPolicy: "Enabled", targetServer: secondary.serverId },
 * });
 * // read-only clients connect to group.readOnlyListenerEndpoint
 * ```
 *
 * ### Standby Replicas
 * **Example:** License-free disaster-recovery secondary
 * ```typescript
 * yield* Azure.Sql.FailoverGroup("Orders", {
 *   server: primary.serverName,
 *   partnerServers: [secondary.serverId],
 *   databases: [db.databaseId],
 *   secondaryType: "Standby",
 * });
 * ```
 *
 * ### Runtime Operations
 * `FailoverFailoverGroup` runs a planned failover: the partner server you
 * bind becomes the primary with no data loss. The binding assigns a custom
 * role with only `Microsoft.Sql/servers/failoverGroups/failover/action`, on
 * the group as seen from that partner server.
 *
 * **Example:** Fail over to the secondary from a Function
 * ```typescript
 * // init
 * const failover = yield* Azure.Sql.FailoverFailoverGroup(group, secondary);
 *
 * // runtime: Azure accepts the request; the failover finishes in the background
 * yield* failover();
 * // …provided with Effect.provide(Azure.Sql.FailoverFailoverGroupHttp)
 * ```
 *
 * @resource
 */
export const FailoverGroup = GroupedResource<FailoverGroup>("Azure.Sql.FailoverGroup");

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
  (desired.failoverPolicy !== undefined && observed?.failoverPolicy !== desired.failoverPolicy) ||
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
      const name = output?.failoverGroupName ?? olds?.name ?? (yield* createDnsName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, serverName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name = news.name ?? output?.failoverGroupName ?? (yield* createDnsName(id));
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
      const waitExists = waitForProvisioned(`sql failover group ${name}`, get, () => undefined, {
        interval: "5 seconds",
        times: 120,
      });

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
      if (news.secondaryType !== undefined && props?.secondaryType !== news.secondaryType) {
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
        getGroup(subscriptionId, output.resourceGroup, output.serverName, output.failoverGroupName),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
