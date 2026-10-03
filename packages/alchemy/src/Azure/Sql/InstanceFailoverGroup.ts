import * as sql from "@distilled.cloud/azure/sql";
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
import { createDnsName, lower, sameId } from "./common.ts";

/** A primary/secondary pair of managed instances in a failover group. */
export interface ManagedInstancePair {
  /** ARM ID of the primary managed instance. */
  primaryManagedInstanceId: string;
  /** ARM ID of the secondary (partner) managed instance. */
  partnerManagedInstanceId: string;
}

export interface InstanceFailoverGroupProps {
  /**
   * Resource group of the primary managed instance. Changing it replaces
   * the failover group.
   */
  resourceGroup: string;
  /**
   * Location of the primary managed instance. Changing it replaces the
   * failover group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Failover group name (lowercase letters, digits, and hyphens; it becomes
   * the listener DNS label). If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the failover group.
   */
  name?: string;
  /**
   * The managed instance pair. The secondary must share the primary's DNS
   * zone (create it with `dnsZonePartner`). Changing it replaces the
   * failover group.
   */
  managedInstancePair: ManagedInstancePair;
  /**
   * Location of the secondary managed instance. Changing it replaces the
   * failover group.
   */
  partnerLocation: string;
  /**
   * Failover policy of the read-write listener. `Automatic` requires
   * `failoverWithDataLossGracePeriodMinutes`.
   * @default "Manual"
   */
  failoverPolicy?: "Automatic" | "Manual";
  /**
   * Minutes to wait before an automatic failover with possible data loss.
   * @default 60 when `failoverPolicy` is `Automatic`
   */
  failoverWithDataLossGracePeriodMinutes?: number;
  /**
   * Whether the read-only listener fails over to the primary when the
   * secondary is unavailable.
   */
  readOnlyFailoverPolicy?: "Enabled" | "Disabled";
  /**
   * `Standby` marks the secondary as a passive disaster-recovery replica
   * (license-free); `Geo` makes it readable.
   * @default "Geo"
   */
  secondaryType?: "Geo" | "Standby";
}

export interface InstanceFailoverGroup extends Resource<
  "Azure.Sql.InstanceFailoverGroup",
  InstanceFailoverGroupProps,
  {
    /** Name of the failover group. */
    failoverGroupName: string;
    /** ARM resource ID of the failover group. */
    failoverGroupId: string;
    /** Resource group of the primary managed instance. */
    resourceGroup: string;
    /** Location of the primary managed instance. */
    location: string;
    /** Replication role of the local instance (`Primary`/`Secondary`). */
    replicationRole: string | undefined;
    /** Replication state, e.g. `CATCH_UP` or `SEEDING`. */
    replicationState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An auto-failover group for Azure SQL Managed Instances: geo-replicates
 * every user database of a primary instance to a secondary instance in
 * another region and exposes read-write and read-only listeners that
 * follow failovers.
 *
 * Failover groups cannot be tagged; Alchemy treats a group as its own when
 * its name is the one Alchemy generated for this resource (or it was
 * created by a previous deploy). Initial seeding can take hours.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/failover-group-sql-mi
 *
 * ### Geo-Replicating a Managed Instance
 * **Example:** Manual failover group
 * ```typescript
 * yield* Azure.Sql.InstanceFailoverGroup("fog", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   partnerLocation: "eastus2",
 *   managedInstancePair: {
 *     primaryManagedInstanceId: primary.managedInstanceId,
 *     partnerManagedInstanceId: secondary.managedInstanceId,
 *   },
 * });
 * ```
 *
 * **Example:** Automatic failover after one hour
 * ```typescript
 * yield* Azure.Sql.InstanceFailoverGroup("fog", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "centralus",
 *   partnerLocation: "eastus2",
 *   managedInstancePair: {
 *     primaryManagedInstanceId: primary.managedInstanceId,
 *     partnerManagedInstanceId: secondary.managedInstanceId,
 *   },
 *   failoverPolicy: "Automatic",
 *   failoverWithDataLossGracePeriodMinutes: 60,
 *   secondaryType: "Standby",
 * });
 * ```
 *
 * @resource
 */
export const InstanceFailoverGroup = Resource<InstanceFailoverGroup>(
  "Azure.Sql.InstanceFailoverGroup",
);

type ObservedGroup = sql.GetInstanceFailoverGroupResponse;

const getGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  locationName: string,
  failoverGroupName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetInstanceFailoverGroup({
      subscriptionId,
      resourceGroupName,
      locationName,
      failoverGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  location: string,
  name: string,
  group: ObservedGroup,
): InstanceFailoverGroup["Attributes"] => ({
  failoverGroupName: name,
  failoverGroupId: group.id ?? "",
  resourceGroup,
  location,
  replicationRole: group.properties?.replicationRole,
  replicationState: group.properties?.replicationState,
});

/** Failover group operations seed whole instances: poll up to 6 h. */
const SLOW = { interval: "60 seconds", times: 360 } as const;

export const InstanceFailoverGroupProvider = () =>
  Provider.succeed(InstanceFailoverGroup, {
    stables: [
      "failoverGroupName",
      "failoverGroupId",
      "resourceGroup",
      "location",
    ],

    // No tags; failover groups are removed with their managed instances.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.failoverGroupName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (olds !== undefined &&
          (lower(news.partnerLocation) !== lower(olds.partnerLocation) ||
            !sameId(
              news.managedInstancePair.primaryManagedInstanceId,
              olds.managedInstancePair.primaryManagedInstanceId,
            ) ||
            !sameId(
              news.managedInstancePair.partnerManagedInstanceId,
              olds.managedInstancePair.partnerManagedInstanceId,
            )))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const location = output?.location ?? olds?.location ?? env.location;
      const generated = yield* createDnsName(id);
      const name = output?.failoverGroupName ?? olds?.name ?? generated;
      const observed = yield* getGroup(
        env.subscriptionId,
        resourceGroup,
        location,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, location, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const resourceGroup = news.resourceGroup;
      const location = news.location ?? output?.location ?? env.location;
      const name =
        news.name ?? output?.failoverGroupName ?? (yield* createDnsName(id));
      const failoverPolicy = news.failoverPolicy ?? "Manual";
      const readWriteEndpoint: sql.InstanceFailoverGroupReadWriteEndpoint = {
        failoverPolicy,
        failoverWithDataLossGracePeriodMinutes:
          failoverPolicy === "Automatic"
            ? (news.failoverWithDataLossGracePeriodMinutes ?? 60)
            : undefined,
      };
      const get = getGroup(subscriptionId, resourceGroup, location, name);
      const matches = (group: ObservedGroup) => {
        const props = group.properties;
        return (
          lower(props?.readWriteEndpoint.failoverPolicy) ===
            lower(failoverPolicy) &&
          (readWriteEndpoint.failoverWithDataLossGracePeriodMinutes ===
            undefined ||
            props?.readWriteEndpoint.failoverWithDataLossGracePeriodMinutes ===
              readWriteEndpoint.failoverWithDataLossGracePeriodMinutes) &&
          (news.readOnlyFailoverPolicy === undefined ||
            lower(props?.readOnlyEndpoint?.failoverPolicy) ===
              lower(news.readOnlyFailoverPolicy)) &&
          (news.secondaryType === undefined ||
            lower(props?.secondaryType) === lower(news.secondaryType))
        );
      };

      // Observe, then create or converge the endpoints in one long-running
      // PUT (the partner/pair fields are immutable and replace via diff).
      const observed = yield* get;
      if (observed === undefined || !matches(observed)) {
        yield* sql.InstanceFailoverGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          locationName: location,
          failoverGroupName: name,
          properties: {
            readWriteEndpoint,
            readOnlyEndpoint:
              news.readOnlyFailoverPolicy === undefined
                ? undefined
                : { failoverPolicy: news.readOnlyFailoverPolicy },
            secondaryType: news.secondaryType,
            partnerRegions: [{ location: news.partnerLocation }],
            managedInstancePairs: [news.managedInstancePair],
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql instance failover group ${name}`,
        get,
        (group) => (matches(group) ? "Succeeded" : "Updating"),
        SLOW,
      );
      return toAttrs(resourceGroup, location, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteInstanceFailoverGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          locationName: output.location,
          failoverGroupName: output.failoverGroupName,
        }),
      );
      yield* waitUntilGone(
        `sql instance failover group ${output.failoverGroupName}`,
        getGroup(
          subscriptionId,
          output.resourceGroup,
          output.location,
          output.failoverGroupName,
        ),
        SLOW,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Sql.ManagedInstance"],
    },
  });
