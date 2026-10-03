import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
import {
  canonicalJson,
  getSqlVirtualMachineGroup,
  lower,
  matchesObserved,
  unredact,
} from "./common.ts";

/**
 * Active Directory accounts and witness used to operate the Windows Server
 * Failover Cluster (WSFC) behind the group.
 */
export interface WsfcDomainProfile {
  /** Fully qualified name of the AD domain, e.g. `contoso.com`. */
  domainFqdn?: string;
  /** Organizational Unit path in which the nodes and cluster are created. */
  ouPath?: string;
  /**
   * Account used to create the cluster (needs `Create Computer Objects`
   * on the domain), e.g. `bootstrap@contoso.com`.
   */
  clusterBootstrapAccount?: string;
  /**
   * Account used to operate the cluster; joins the administrators group on
   * every participating VM.
   */
  clusterOperatorAccount?: string;
  /** Account the SQL Server service runs as on every participating VM. */
  sqlServiceAccount?: string;
  /** Whether `sqlServiceAccount` is a group managed service account. */
  isSqlServiceAccountGmsa?: boolean;
  /** Optional file share witness path. */
  fileShareWitnessPath?: string;
  /** Blob endpoint URL of the cloud witness storage account. */
  storageAccountUrl?: string;
  /**
   * Primary key of the cloud witness storage account. Write-only: Azure
   * never returns it.
   */
  storageAccountPrimaryKey?: Redacted.Redacted<string>;
  /** Cluster subnet type: `SingleSubnet` or `MultiSubnet`. */
  clusterSubnetType?: "SingleSubnet" | "MultiSubnet";
}

export interface SqlVirtualMachineGroupProps {
  /** Resource group the group is created in. Changing it replaces the group. */
  resourceGroup: string;
  /**
   * Group name; also the WSFC cluster name, so at most 15 characters. If
   * omitted, a unique name is generated. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location; must match the SQL VMs that join the group. Changing it
   * replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SQL image offer of the member VMs, e.g. `SQL2022-WS2022`. Changing it
   * replaces the group.
   */
  sqlImageOffer: string;
  /**
   * SQL Server edition of the member VMs. Changing it replaces the group.
   */
  sqlImageSku: "Developer" | "Enterprise";
  /**
   * Active Directory profile of the failover cluster. Mutable until SQL VMs
   * join the group.
   */
  wsfcDomainProfile?: WsfcDomainProfile;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SqlVirtualMachineGroup extends Resource<
  "Azure.SqlVirtualMachine.SqlVirtualMachineGroup",
  SqlVirtualMachineGroupProps,
  {
    /** Name of the group (and of its WSFC cluster). */
    sqlVirtualMachineGroupName: string;
    /** ARM resource ID of the group; pass it to SQL VMs that join. */
    sqlVirtualMachineGroupId: string;
    /** Resource group that holds the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** SQL image offer of the member VMs. */
    sqlImageOffer: string | undefined;
    /** SQL Server edition of the member VMs. */
    sqlImageSku: string | undefined;
    /** Scale type, e.g. `HA`. */
    scaleType: string | undefined;
    /** Cluster manager type, e.g. `WSFC`. */
    clusterManagerType: string | undefined;
    /** Cluster configuration, e.g. `Domainful`. */
    clusterConfiguration: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A SQL virtual machine group — the Windows Server Failover Cluster that
 * hosts a SQL Server Always On availability group across SQL VMs. SQL VMs
 * join the group through `sqlVirtualMachineGroupId`; listeners are added
 * with `AvailabilityGroupListener`.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/availability-group-az-commandline-configure
 *
 * ### Creating a Group
 * **Example:** Group for a domain-joined cluster
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("sql");
 * const cluster = yield* Azure.SqlVirtualMachine.SqlVirtualMachineGroup("cluster", {
 *   resourceGroup: group.resourceGroupName,
 *   sqlImageOffer: "SQL2022-WS2022",
 *   sqlImageSku: "Enterprise",
 *   wsfcDomainProfile: {
 *     domainFqdn: "contoso.com",
 *     clusterBootstrapAccount: "bootstrap@contoso.com",
 *     clusterOperatorAccount: "operator@contoso.com",
 *     sqlServiceAccount: "sqlservice@contoso.com",
 *     storageAccountUrl: witness.primaryEndpoints.blob,
 *     storageAccountPrimaryKey: Redacted.make(witnessKey),
 *     clusterSubnetType: "SingleSubnet",
 *   },
 * });
 * ```
 *
 * ### Joining SQL VMs
 * **Example:** Register a SQL VM into the group
 * ```typescript
 * yield* Azure.SqlVirtualMachine.SqlVirtualMachine("sql1", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachineId: vm1.virtualMachineId,
 *   sqlServerLicenseType: "PAYG",
 *   sqlVirtualMachineGroupResourceId: cluster.sqlVirtualMachineGroupId,
 *   wsfcDomainCredentials: {
 *     clusterBootstrapAccountPassword: bootstrapPassword,
 *     clusterOperatorAccountPassword: operatorPassword,
 *     sqlServiceAccountPassword: sqlServicePassword,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SqlVirtualMachineGroup = Resource<SqlVirtualMachineGroup>(
  "Azure.SqlVirtualMachine.SqlVirtualMachineGroup",
);

type Observed = sqlvm.GetSqlVirtualMachineGroupResponse;

const createGroupName = (id: string) =>
  createPhysicalName({ id, maxLength: 15, lowercase: true, delimiter: "-" });

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: Observed,
): SqlVirtualMachineGroup["Attributes"] => ({
  sqlVirtualMachineGroupName: name,
  sqlVirtualMachineGroupId: group.id ?? "",
  resourceGroup,
  location: group.location,
  sqlImageOffer: group.properties?.sqlImageOffer,
  sqlImageSku: group.properties?.sqlImageSku,
  scaleType: group.properties?.scaleType,
  clusterManagerType: group.properties?.clusterManagerType,
  clusterConfiguration: group.properties?.clusterConfiguration,
  tags: userTags(group.tags),
});

const SECRET_KEYS = new Set(["storageAccountPrimaryKey"]);

export const SqlVirtualMachineGroupProvider = () =>
  Provider.succeed(SqlVirtualMachineGroup, {
    stables: [
      "sqlVirtualMachineGroupName",
      "sqlVirtualMachineGroupId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        sqlvm.ListSqlVirtualMachineGroups({ subscriptionId }),
      );
      if (page === undefined) return [];
      yield* requireSinglePage("ListSqlVirtualMachineGroups", page);
      return (page.value ?? []).flatMap((group) => {
        const resourceGroup = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) &&
          resourceGroup !== undefined &&
          group.name !== undefined
          ? [toAttrs(resourceGroup, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.sqlVirtualMachineGroupName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        lower(news.sqlImageOffer) !== lower(output.sqlImageOffer) ||
        lower(news.sqlImageSku) !== lower(output.sqlImageSku)
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
        output?.sqlVirtualMachineGroupName ??
        olds?.name ??
        (yield* createGroupName(id));
      const observed = yield* getSqlVirtualMachineGroup(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.SqlVirtualMachine");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.sqlVirtualMachineGroupName ??
        (yield* createGroupName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sqlVirtualMachineGroupName: name,
      };
      const label = `SQL virtual machine group ${name}`;
      const get = getSqlVirtualMachineGroup(
        subscriptionId,
        resourceGroup,
        name,
      );
      const wait = waitForProvisioned(
        label,
        get,
        (group) => group.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync settings: the PUT is a full upsert. The witness key is
      // write-only, so its drift is detected against the previous props.
      const profileDrifted =
        observed !== undefined &&
        (!matchesObserved(
          news.wsfcDomainProfile,
          observed.properties?.wsfcDomainProfile,
          SECRET_KEYS,
        ) ||
          canonicalJson(news.wsfcDomainProfile?.storageAccountPrimaryKey) !==
            canonicalJson(olds?.wsfcDomainProfile?.storageAccountPrimaryKey));
      if (observed === undefined || profileDrifted) {
        yield* sqlvm.SqlVirtualMachineGroupsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            sqlImageOffer: news.sqlImageOffer,
            sqlImageSku: news.sqlImageSku,
            wsfcDomainProfile: unredact(
              news.wsfcDomainProfile,
            ) as sqlvm.WsfcDomainProfile,
          },
        });
      }
      observed = yield* wait;

      // Sync tags against observed tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* sqlvm.UpdateSqlVirtualMachineGroup({ ...where, tags });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Listeners must be gone before the cluster can be torn down.
      yield* waitUntilGone(
        `listeners of SQL virtual machine group ${output.sqlVirtualMachineGroupName}`,
        orUndefinedIfNotFound(
          sqlvm.ListAvailabilityGroupListenerByGroup({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            sqlVirtualMachineGroupName: output.sqlVirtualMachineGroupName,
          }),
        ).pipe(
          Effect.map((page) =>
            page === undefined || (page.value ?? []).length === 0
              ? undefined
              : page,
          ),
        ),
        { interval: "10 seconds", times: 60 },
      );
      yield* ignoreNotFound(
        sqlvm.DeleteSqlVirtualMachineGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sqlVirtualMachineGroupName: output.sqlVirtualMachineGroupName,
        }),
      );
      yield* waitUntilGone(
        `SQL virtual machine group ${output.sqlVirtualMachineGroupName}`,
        getSqlVirtualMachineGroup(
          subscriptionId,
          output.resourceGroup,
          output.sqlVirtualMachineGroupName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
