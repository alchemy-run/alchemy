import * as netapp from "@distilled.cloud/azure/netapp";
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
import { createNetAppName, LRO_BUDGET, whileBusy } from "./Common.ts";

export type VolumeQuotaType =
  | "DefaultUserQuota"
  | "DefaultGroupQuota"
  | "IndividualUserQuota"
  | "IndividualGroupQuota";

export interface VolumeQuotaRuleProps {
  /** Resource group of the NetApp account. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the rule. */
  account: string;
  /** Name of the capacity pool. Changing it replaces the rule. */
  pool: string;
  /** Name of the volume the rule applies to. Changing it replaces the rule. */
  volume: string;
  /**
   * Rule name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /** Kind of quota. Changing it replaces the rule. */
  quotaType: VolumeQuotaType;
  /**
   * UID / GID (NFS) or SID (SMB) the quota applies to. Required for
   * individual quotas, omitted for default quotas. Changing it replaces the
   * rule.
   */
  quotaTarget?: string;
  /** Quota size in KiB (at least 4). */
  quotaSizeInKiBs: number;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VolumeQuotaRule extends Resource<
  "Azure.NetApp.VolumeQuotaRule",
  VolumeQuotaRuleProps,
  {
    /** Name of the quota rule. */
    volumeQuotaRuleName: string;
    /** ARM resource ID of the rule. */
    volumeQuotaRuleId: string;
    /** Parent NetApp account. */
    account: string;
    /** Parent capacity pool. */
    pool: string;
    /** Parent volume. */
    volume: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the rule. */
    location: string;
    /** Kind of quota. */
    quotaType: string;
    /** Target UID / GID / SID. */
    quotaTarget: string | undefined;
    /** Quota size in KiB. */
    quotaSizeInKiBs: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files volume quota rule — a default or per-user /
 * per-group capacity limit inside a volume. Quota rules are deleted
 * together with their volume.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/manage-default-individual-user-group-quotas
 *
 * ### Default Quotas
 * **Example:** Limit every user to 10 GiB
 * ```typescript
 * const rule = yield* Azure.NetApp.VolumeQuotaRule("per-user", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   volume: volume.volumeName,
 *   quotaType: "DefaultUserQuota",
 *   quotaSizeInKiBs: 10 * 1024 * 1024,
 * });
 * ```
 *
 * ### Individual Quotas
 * **Example:** Give UID 1001 50 GiB
 * ```typescript
 * const rule = yield* Azure.NetApp.VolumeQuotaRule("uid-1001", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   volume: volume.volumeName,
 *   quotaType: "IndividualUserQuota",
 *   quotaTarget: "1001",
 *   quotaSizeInKiBs: 50 * 1024 * 1024,
 * });
 * ```
 *
 * @resource
 */
export const VolumeQuotaRule = Resource<VolumeQuotaRule>(
  "Azure.NetApp.VolumeQuotaRule",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  accountName: string;
  poolName: string;
  volumeName: string;
  volumeQuotaRuleName: string;
}

const getRule = (where: Where) =>
  orUndefinedIfNotFound(netapp.GetVolumeQuotaRule(where));

const toAttrs = (
  where: Where,
  rule: netapp.GetVolumeQuotaRuleResponse,
): VolumeQuotaRule["Attributes"] => ({
  volumeQuotaRuleName: where.volumeQuotaRuleName,
  volumeQuotaRuleId: rule.id ?? "",
  account: where.accountName,
  pool: where.poolName,
  volume: where.volumeName,
  resourceGroup: where.resourceGroupName,
  location: rule.location ?? "",
  quotaType: rule.properties?.quotaType ?? "",
  quotaTarget: rule.properties?.quotaTarget || undefined,
  quotaSizeInKiBs: rule.properties?.quotaSizeInKiBs,
  tags: userTags(rule.tags),
});

export const VolumeQuotaRuleProvider = () =>
  Provider.succeed(VolumeQuotaRule, {
    stables: [
      "volumeQuotaRuleName",
      "volumeQuotaRuleId",
      "account",
      "pool",
      "volume",
      "resourceGroup",
      "location",
      "quotaType",
      "quotaTarget",
    ],

    // Quota rules are deleted with their volume; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.pool.toLowerCase() !== output.pool.toLowerCase() ||
        news.volume.toLowerCase() !== output.volume.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.volumeQuotaRuleName.toLowerCase()) ||
        news.quotaType !== output.quotaType ||
        (news.quotaTarget || undefined) !== output.quotaTarget
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.account ?? olds?.account;
      const poolName = output?.pool ?? olds?.pool;
      const volumeName = output?.volume ?? olds?.volume;
      if (!resourceGroupName || !accountName || !poolName || !volumeName) {
        return undefined;
      }
      const where = {
        subscriptionId,
        resourceGroupName,
        accountName,
        poolName,
        volumeName,
        volumeQuotaRuleName:
          output?.volumeQuotaRuleName ??
          olds?.name ??
          (yield* createNetAppName(id, 64)),
      };
      const observed = yield* getRule(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        accountName: news.account,
        poolName: news.pool,
        volumeName: news.volume,
        volumeQuotaRuleName:
          news.name ??
          output?.volumeQuotaRuleName ??
          (yield* createNetAppName(id, 64)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const get = getRule(where);
      const waitReady = waitForProvisioned(
        `volume quota rule ${where.volumeQuotaRuleName}`,
        get,
        (rule) => rule.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = yield* netapp.GetVolume({
          subscriptionId,
          resourceGroupName: where.resourceGroupName,
          accountName: where.accountName,
          poolName: where.poolName,
          volumeName: where.volumeName,
        });
        yield* whileBusy(
          netapp.CreateVolumeQuotaRule({
            ...where,
            location: parent.location,
            tags,
            properties: {
              quotaType: news.quotaType,
              quotaTarget: news.quotaTarget,
              quotaSizeInKiBs: news.quotaSizeInKiBs,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync size and tags against observed state.
      const sizeChanged =
        observed.properties?.quotaSizeInKiBs !== news.quotaSizeInKiBs;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (sizeChanged || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateVolumeQuotaRule({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: sizeChanged
              ? { quotaSizeInKiBs: news.quotaSizeInKiBs }
              : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        poolName: output.pool,
        volumeName: output.volume,
        volumeQuotaRuleName: output.volumeQuotaRuleName,
      };
      yield* whileBusy(ignoreNotFound(netapp.DeleteVolumeQuotaRule(where)));
      yield* waitUntilGone(
        `volume quota rule ${output.volumeQuotaRuleName}`,
        getRule(where),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Volume", "Azure.Resources.ResourceGroup"],
    },
  });
