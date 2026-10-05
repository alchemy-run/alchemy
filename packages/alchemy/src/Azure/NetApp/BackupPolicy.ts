import * as netapp from "@distilled.cloud/azure/netapp";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountLocation,
  createNetAppName,
  accountRefs,
  listAllAccounts,
  LRO_BUDGET,
  matchesObserved,
  parseNetAppId,
  whileBusy,
} from "./Common.ts";

export interface BackupPolicyProps {
  /** Resource group of the NetApp account. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the policy. */
  account: string;
  /**
   * Policy name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /** Number of daily backups to keep (2-1019 combined). */
  dailyBackupsToKeep?: number;
  /** Number of weekly backups to keep. */
  weeklyBackupsToKeep?: number;
  /** Number of monthly backups to keep. */
  monthlyBackupsToKeep?: number;
  /**
   * Whether the policy takes backups.
   * @default true
   */
  enabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BackupPolicy extends Resource<
  "Azure.NetApp.BackupPolicy",
  BackupPolicyProps,
  {
    /** Name of the backup policy. */
    backupPolicyName: string;
    /** ARM resource ID of the policy; assign it to volumes via `backupPolicyId`. */
    backupPolicyId: string;
    /** UUID of the policy. */
    backupPolicyUuid: string | undefined;
    /** Parent NetApp account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Whether the policy is enabled. */
    enabled: boolean;
    /** Number of volumes the policy is assigned to. */
    volumesAssigned: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files backup policy — daily, weekly, and monthly
 * retention of volume backups stored in a backup vault. The policy itself
 * is free; stored backups are billed.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/backup-configure-policy-based
 *
 * ### Creating a Backup Policy
 * **Example:** Keep a week of dailies and a month of weeklies
 * ```typescript
 * const policy = yield* Azure.NetApp.BackupPolicy("backups", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   dailyBackupsToKeep: 7,
 *   weeklyBackupsToKeep: 4,
 *   monthlyBackupsToKeep: 0,
 * });
 * ```
 *
 * ### Using the Policy
 * **Example:** Back up a volume into a vault
 * ```typescript
 * const vault = yield* Azure.NetApp.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 * });
 * const volume = yield* Azure.NetApp.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   subnetId: subnet.subnetId,
 *   backupPolicyId: policy.backupPolicyId,
 *   backupVaultId: vault.backupVaultId,
 * });
 * ```
 *
 * @resource
 */
export const BackupPolicy = Resource<BackupPolicy>("Azure.NetApp.BackupPolicy");

const getBackupPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  backupPolicyName: string,
) =>
  orUndefinedIfNotFound(
    netapp.GetBackupPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      backupPolicyName,
    }),
  );

type ObservedPolicy = netapp.GetBackupPolicyResponse | netapp.BackupPolicy;

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  policy: ObservedPolicy,
): BackupPolicy["Attributes"] => ({
  backupPolicyName: name,
  backupPolicyId: policy.id ?? "",
  backupPolicyUuid: policy.properties?.backupPolicyId,
  account,
  resourceGroup,
  location: policy.location ?? "",
  enabled: policy.properties?.enabled ?? false,
  volumesAssigned: policy.properties?.volumesAssigned,
  tags: userTags(policy.tags),
});

export const BackupPolicyProvider = () =>
  Provider.succeed(BackupPolicy, {
    stables: [
      "backupPolicyName",
      "backupPolicyId",
      "backupPolicyUuid",
      "account",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const accounts = yield* listAllAccounts(subscriptionId);
      const policies = yield* Effect.forEach(
        accountRefs(accounts),
        ({ resourceGroup, accountName }) =>
          orUndefinedIfNotFound(
            netapp
              .ListBackupPolicies({
                subscriptionId,
                resourceGroupName: resourceGroup,
                accountName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListBackupPolicies", page),
                ),
              ),
          ).pipe(Effect.map((page) => page?.value ?? [])),
      );
      return policies.flat().flatMap((policy) => {
        const { resourceGroup, account, name } = parseNetAppId(policy.id);
        return hasAnyAlchemyTag(policy.tags) && resourceGroup && account && name
          ? [toAttrs(resourceGroup, account, name, policy)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.backupPolicyName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (!resourceGroup || !account) return undefined;
      const name =
        output?.backupPolicyName ??
        olds?.name ??
        (yield* createNetAppName(id, 64));
      const observed = yield* getBackupPolicy(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const { resourceGroup, account } = news;
      const name =
        news.name ??
        output?.backupPolicyName ??
        (yield* createNetAppName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const desired: netapp.BackupPolicyPropertiesInput = {
        dailyBackupsToKeep: news.dailyBackupsToKeep,
        weeklyBackupsToKeep: news.weeklyBackupsToKeep,
        monthlyBackupsToKeep: news.monthlyBackupsToKeep,
        enabled: news.enabled ?? true,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        backupPolicyName: name,
      };
      const get = getBackupPolicy(subscriptionId, resourceGroup, account, name);
      const waitReady = waitForProvisioned(
        `backup policy ${name}`,
        get,
        (policy) => policy.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          output?.location ??
          (yield* accountLocation(subscriptionId, resourceGroup, account));
        yield* whileBusy(
          netapp.CreateBackupPolicy({
            ...where,
            location,
            tags,
            properties: desired,
          }),
        );
      }
      observed = yield* waitReady;

      // Sync retention, enabled flag, and tags against observed state.
      const propsChanged = !matchesObserved(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (propsChanged || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateBackupPolicy({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: propsChanged ? desired : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, account, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeleteBackupPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            backupPolicyName: output.backupPolicyName,
          }),
        ),
      );
      yield* waitUntilGone(
        `backup policy ${output.backupPolicyName}`,
        getBackupPolicy(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.backupPolicyName,
        ),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Account", "Azure.Resources.ResourceGroup"],
    },
  });
