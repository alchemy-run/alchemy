import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  isSubset,
  isVaultOwnedByStack,
  NAMESPACE,
  sameText,
} from "./Common.ts";

/** A datastore reference inside a policy rule. */
export interface BackupDataStoreInfo {
  /** Datastore type. */
  dataStoreType: "OperationalStore" | "VaultStore" | "ArchiveStore";
  /** Always `DataStoreInfoBase`. */
  objectType: "DataStoreInfoBase";
}

/** When a backup runs and how its recovery points are tagged. */
export interface BackupScheduleTrigger {
  /** `ScheduleBasedTriggerContext` for scheduled backups. */
  objectType: "ScheduleBasedTriggerContext";
  /** Schedule, e.g. `{ repeatingTimeIntervals: ["R/2024-01-01T02:00:00+00:00/P1D"] }`. */
  schedule: {
    /** ISO 8601 repeating intervals. */
    repeatingTimeIntervals: string[];
    /** Time zone of the schedule. */
    timeZone?: string;
  };
  /** Tagging criteria that map recovery points to retention rules. */
  taggingCriteria: Array<{
    /** Whether this is the default tag. */
    isDefault: boolean;
    /** Retention tag, e.g. `{ tagName: "Default" }`. */
    tagInfo: { tagName: string; id?: string };
    /** Priority (lower wins). */
    taggingPriority: number;
    /** Criteria selecting recovery points for this tag. */
    criteria?: Array<Record<string, unknown>>;
  }>;
}

/** A backup rule (`AzureBackupRule`). */
export interface AzureBackupRule {
  /** Always `AzureBackupRule`. */
  objectType: "AzureBackupRule";
  /** Rule name, e.g. `BackupDaily`. */
  name: string;
  /** Datastore backups are written to. */
  dataStore: BackupDataStoreInfo;
  /** Backup parameters, e.g. `{ objectType: "AzureBackupParams", backupType: "Incremental" }`. */
  backupParameters?: { objectType: "AzureBackupParams"; backupType: string };
  /** Schedule trigger. */
  trigger: BackupScheduleTrigger | Record<string, unknown>;
}

/** A retention rule (`AzureRetentionRule`). */
export interface AzureRetentionRule {
  /** Always `AzureRetentionRule`. */
  objectType: "AzureRetentionRule";
  /** Rule name, e.g. `Default`. */
  name: string;
  /** Whether this is the default retention rule. */
  isDefault?: boolean;
  /** Retention lifecycles. */
  lifecycles: Array<{
    /** When recovery points are deleted, e.g. `{ objectType: "AbsoluteDeleteOption", duration: "P30D" }`. */
    deleteAfter: { objectType: "AbsoluteDeleteOption"; duration: string };
    /** Datastore the lifecycle applies to. */
    sourceDataStore: BackupDataStoreInfo;
    /** Copy settings to other datastores (e.g. tier to `ArchiveStore`). */
    targetDataStoreCopySettings?: Array<Record<string, unknown>>;
  }>;
}

export type BackupPolicyRule = AzureBackupRule | AzureRetentionRule;

export interface BackupPolicyProps {
  /** Resource group of the Backup vault. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the Backup vault that holds the policy. Changing it replaces the policy. */
  backupVault: string;
  /**
   * Policy name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Data source types the policy protects, e.g.
   * `Microsoft.Storage/storageAccounts/blobServices`,
   * `Microsoft.Compute/disks`, `Microsoft.DBforPostgreSQL/flexibleServers`,
   * `Microsoft.ContainerService/managedClusters`. Changing it replaces the
   * policy.
   */
  datasourceTypes: string[];
  /**
   * Backup and retention rules. Azure does not support updating an existing
   * policy, so changing the rules replaces the policy (instances using it
   * must move to the new policy, which happens in the same deploy).
   */
  policyRules: BackupPolicyRule[];
}

export interface BackupPolicy extends Resource<
  "Azure.DataProtection.BackupPolicy",
  BackupPolicyProps,
  {
    /** Name of the policy. */
    backupPolicyName: string;
    /** ARM resource ID of the policy; pass it to a {@link BackupInstance}. */
    backupPolicyId: string;
    /** Backup vault that holds the policy. */
    backupVault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** Data source types the policy protects. */
    datasourceTypes: string[];
  },
  never,
  Providers
> {}

/**
 * A backup policy in an Azure Backup vault
 * (`Microsoft.DataProtection/backupVaults/backupPolicies`) — the schedule
 * and retention rules a {@link BackupInstance} is protected with.
 *
 * Policies cannot be tagged; Alchemy treats a policy as owned when its
 * vault is owned by the current stack and stage. Azure does not allow
 * updating a policy, so any rule change replaces it.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-vault-overview
 *
 * ### Creating a Backup Policy
 * **Example:** Operational blob backup retained for 30 days
 * ```typescript
 * const policy = yield* Azure.DataProtection.BackupPolicy("blobs", {
 *   resourceGroup: group.resourceGroupName,
 *   backupVault: vault.backupVaultName,
 *   datasourceTypes: ["Microsoft.Storage/storageAccounts/blobServices"],
 *   policyRules: [
 *     {
 *       objectType: "AzureRetentionRule",
 *       name: "Default",
 *       isDefault: true,
 *       lifecycles: [
 *         {
 *           deleteAfter: { objectType: "AbsoluteDeleteOption", duration: "P30D" },
 *           sourceDataStore: {
 *             dataStoreType: "OperationalStore",
 *             objectType: "DataStoreInfoBase",
 *           },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Scheduled Backups
 * **Example:** Daily disk snapshots kept for 7 days
 * ```typescript
 * const policy = yield* Azure.DataProtection.BackupPolicy("disks", {
 *   resourceGroup: group.resourceGroupName,
 *   backupVault: vault.backupVaultName,
 *   datasourceTypes: ["Microsoft.Compute/disks"],
 *   policyRules: [
 *     {
 *       objectType: "AzureBackupRule",
 *       name: "BackupDaily",
 *       dataStore: { dataStoreType: "OperationalStore", objectType: "DataStoreInfoBase" },
 *       backupParameters: { objectType: "AzureBackupParams", backupType: "Incremental" },
 *       trigger: {
 *         objectType: "ScheduleBasedTriggerContext",
 *         schedule: { repeatingTimeIntervals: ["R/2024-01-01T02:00:00+00:00/P1D"] },
 *         taggingCriteria: [
 *           { isDefault: true, tagInfo: { tagName: "Default" }, taggingPriority: 99 },
 *         ],
 *       },
 *     },
 *     {
 *       objectType: "AzureRetentionRule",
 *       name: "Default",
 *       isDefault: true,
 *       lifecycles: [
 *         {
 *           deleteAfter: { objectType: "AbsoluteDeleteOption", duration: "P7D" },
 *           sourceDataStore: { dataStoreType: "OperationalStore", objectType: "DataStoreInfoBase" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const BackupPolicy = Resource<BackupPolicy>(
  "Azure.DataProtection.BackupPolicy",
);

const createPolicyName = Effect.fn(function* (id: string) {
  return yield* createPhysicalName({ id, maxLength: 50 });
});

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  backupPolicyName: string,
) =>
  orUndefinedIfNotFound(
    dataprotection.GetBackupPolicy({
      subscriptionId,
      resourceGroupName,
      vaultName,
      backupPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  backupVault: string,
  name: string,
  policy: dataprotection.GetBackupPolicyResponse,
): BackupPolicy["Attributes"] => ({
  backupPolicyName: name,
  backupPolicyId: policy.id ?? "",
  backupVault,
  resourceGroup,
  datasourceTypes: [...(policy.properties?.datasourceTypes ?? [])],
});

const listKey = (list: readonly string[]) =>
  [...list]
    .map((s) => s.toLowerCase())
    .sort()
    .join(",");

export const BackupPolicyProvider = () =>
  Provider.succeed(BackupPolicy, {
    stables: [
      "backupPolicyName",
      "backupPolicyId",
      "backupVault",
      "resourceGroup",
    ],

    // Policies live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        // Azure rejects updates of an existing policy ("Update of existing
        // policy is not supported"), so rule changes replace it.
        (olds !== undefined &&
          !(
            isSubset(news.policyRules, olds.policyRules) &&
            isSubset(olds.policyRules, news.policyRules)
          )) ||
        !sameText(news.backupVault, output.backupVault) ||
        (news.name !== undefined && news.name !== output.backupPolicyName) ||
        listKey(news.datasourceTypes) !== listKey(output.datasourceTypes)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const backupVault = output?.backupVault ?? olds?.backupVault;
      if (resourceGroup === undefined || backupVault === undefined) {
        return undefined;
      }
      const name =
        output?.backupPolicyName ?? olds?.name ?? (yield* createPolicyName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        backupVault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, backupVault, name, observed);
      return (yield* isVaultOwnedByStack(
        subscriptionId,
        resourceGroup,
        backupVault,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, backupVault } = news;
      const name =
        news.name ?? output?.backupPolicyName ?? (yield* createPolicyName(id));
      const get = getPolicy(subscriptionId, resourceGroup, backupVault, name);

      // Observe.
      const observed = yield* get;

      // Ensure: PUT is synchronous. Azure rejects updates of an existing
      // policy, so drifted rules on an adopted policy surface its error.
      if (
        observed === undefined ||
        !isSubset(news.policyRules, observed.properties?.policyRules)
      ) {
        yield* dataprotection.BackupPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: backupVault,
          backupPolicyName: name,
          properties: {
            objectType: "BackupPolicy",
            datasourceTypes: news.datasourceTypes,
            policyRules: news.policyRules,
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `backup policy ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, backupVault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dataprotection.DeleteBackupPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.backupVault,
          backupPolicyName: output.backupPolicyName,
        }),
      );
      yield* waitUntilGone(
        `backup policy ${output.backupPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.backupVault,
          output.backupPolicyName,
        ),
      );
    }),
  });
