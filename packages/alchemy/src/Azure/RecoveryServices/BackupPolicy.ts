import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  ProvisioningTimedOut,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createBackupName,
  isVaultOwnedByStack,
  matchesDesired,
  RECOVERY_SERVICES_NAMESPACE,
} from "./BackupShared.ts";

export type BackupManagementType =
  | "AzureIaasVM"
  | "AzureStorage"
  | "AzureWorkload"
  | "AzureSql"
  | "MAB"
  | "GenericProtectionPolicy";

/** A retention duration, e.g. `{ count: 7, durationType: "Days" }`. */
export interface BackupRetentionDuration {
  /** Number of units. */
  count: number;
  /** Unit of the duration. */
  durationType: "Days" | "Weeks" | "Months" | "Years";
}

/**
 * When backups run. Polymorphic on `schedulePolicyType`; the fields below
 * cover the common shapes, any other service field is passed through.
 */
export interface BackupSchedulePolicy {
  /**
   * Schedule kind: `SimpleSchedulePolicy` (daily/weekly), `SimpleSchedulePolicyV2`
   * (Enhanced IaaS VM / hourly Azure Files), `LongTermSchedulePolicy`,
   * `LogSchedulePolicy` (SQL log backups).
   */
  schedulePolicyType:
    | "SimpleSchedulePolicy"
    | "SimpleSchedulePolicyV2"
    | "LongTermSchedulePolicy"
    | "LogSchedulePolicy";
  /** Frequency of a simple schedule. */
  scheduleRunFrequency?: "Daily" | "Weekly" | "Hourly";
  /**
   * Times of day backups run, as ISO timestamps (only the time of day is
   * used), e.g. `["2026-01-01T23:00:00Z"]`.
   */
  scheduleRunTimes?: string[];
  /** Days of the week for a weekly schedule, e.g. `["Sunday"]`. */
  scheduleRunDays?: string[];
  /** Hourly schedule (`SimpleSchedulePolicyV2`). */
  hourlySchedule?: {
    interval?: number;
    scheduleWindowStartTime?: string;
    scheduleWindowDuration?: number;
  };
  /** Daily schedule (`SimpleSchedulePolicyV2`). */
  dailySchedule?: { scheduleRunTimes?: string[] };
  /** Weekly schedule (`SimpleSchedulePolicyV2`). */
  weeklySchedule?: { scheduleRunDays?: string[]; scheduleRunTimes?: string[] };
  /** Log backup frequency in minutes (`LogSchedulePolicy`). */
  scheduleFrequencyInMins?: number;
  /** Any other service field. */
  [key: string]: unknown;
}

/** A daily/weekly/monthly/yearly retention schedule. */
export interface BackupRetentionSchedule {
  /** Times of day the retained backups are taken (ISO timestamps). */
  retentionTimes?: string[];
  /** How long these recovery points are kept. */
  retentionDuration?: BackupRetentionDuration;
  /** Days of the week (weekly/monthly/yearly weekly-format schedules). */
  daysOfTheWeek?: string[];
  /** Any other service field. */
  [key: string]: unknown;
}

/**
 * How long recovery points are kept. Polymorphic on
 * `retentionPolicyType`; any other service field is passed through.
 */
export interface BackupRetentionPolicy {
  /** `LongTermRetentionPolicy` or `SimpleRetentionPolicy` (SQL log backups). */
  retentionPolicyType: "LongTermRetentionPolicy" | "SimpleRetentionPolicy";
  /** Daily retention. */
  dailySchedule?: BackupRetentionSchedule;
  /** Weekly retention. */
  weeklySchedule?: BackupRetentionSchedule;
  /** Monthly retention. */
  monthlySchedule?: BackupRetentionSchedule;
  /** Yearly retention. */
  yearlySchedule?: BackupRetentionSchedule;
  /** Retention of a `SimpleRetentionPolicy`. */
  retentionDuration?: BackupRetentionDuration;
  /** Any other service field. */
  [key: string]: unknown;
}

export interface BackupPolicyProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the policy. */
  vault: string;
  /**
   * Policy name, unique within the vault. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * policy.
   */
  name?: string;
  /**
   * Workload family the policy protects: `AzureIaasVM` (virtual machines),
   * `AzureStorage` (Azure Files), `AzureWorkload` (SQL/SAP HANA in VMs).
   * Changing it replaces the policy.
   */
  backupManagementType: BackupManagementType;
  /**
   * Workload type of an `AzureStorage`/`AzureWorkload` policy, e.g.
   * `AzureFileShare` or `SQLDataBase`. Changing it replaces the policy.
   */
  workLoadType?: string;
  /**
   * IaaS VM policy generation: `V1` (standard, daily/weekly) or `V2`
   * (enhanced, hourly). Changing it replaces the policy.
   */
  policyType?: "V1" | "V2";
  /** Backup schedule. Required for `AzureIaasVM` and `AzureStorage` policies. */
  schedulePolicy?: BackupSchedulePolicy;
  /** Retention of recovery points. Required for `AzureIaasVM` and `AzureStorage` policies. */
  retentionPolicy?: BackupRetentionPolicy;
  /** Vaulted-tier retention (Azure Files vaulted backup). */
  vaultRetentionPolicy?: Record<string, unknown>;
  /**
   * Time zone of the schedule, e.g. `UTC` or `Pacific Standard Time`.
   * @default "UTC"
   */
  timeZone?: string;
  /** Days instant (snapshot) recovery points are kept (IaaS VM, 1-30). */
  instantRpRetentionRangeInDays?: number;
  /** Archive tiering policy keyed by tier (IaaS VM). */
  tieringPolicy?: Record<string, unknown>;
  /** Workload settings such as time zone and compression (`AzureWorkload`). */
  settings?: Record<string, unknown>;
  /** Sub-policies per backup type: Full, Differential, Log (`AzureWorkload`). */
  subProtectionPolicy?: Record<string, unknown>[];
}

export interface BackupPolicy extends Resource<
  "Azure.RecoveryServices.BackupPolicy",
  BackupPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the policy; pass it as a protected item's `policyId`. */
    policyId: string;
    /** Workload family the policy protects. */
    backupManagementType: string;
    /** Number of items currently protected with this policy. */
    protectedItemsCount: number;
  },
  never,
  Providers
> {}

/**
 * An Azure Backup policy in a Recovery Services vault: when backups run
 * and how long recovery points are kept.
 *
 * Backup policies cannot be tagged; Alchemy treats a policy as owned when
 * its vault is tagged for the current stack and stage. Changing the
 * schedule or retention updates the policy in place and is applied to
 * every item protected by it.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-arm-userestapi-createorupdatepolicy
 *
 * ### Azure Files
 * **Example:** Daily Azure Files backup kept for 7 days
 * ```typescript
 * const policy = yield* Azure.RecoveryServices.BackupPolicy("files-daily", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
 *   backupManagementType: "AzureStorage",
 *   workLoadType: "AzureFileShare",
 *   schedulePolicy: {
 *     schedulePolicyType: "SimpleSchedulePolicy",
 *     scheduleRunFrequency: "Daily",
 *     scheduleRunTimes: ["2026-01-01T23:00:00Z"],
 *   },
 *   retentionPolicy: {
 *     retentionPolicyType: "LongTermRetentionPolicy",
 *     dailySchedule: {
 *       retentionTimes: ["2026-01-01T23:00:00Z"],
 *       retentionDuration: { count: 7, durationType: "Days" },
 *     },
 *   },
 * });
 * ```
 *
 * ### Virtual Machines
 * **Example:** Enhanced (V2) VM policy with a 4-hourly schedule
 * ```typescript
 * const policy = yield* Azure.RecoveryServices.BackupPolicy("vm-hourly", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
 *   backupManagementType: "AzureIaasVM",
 *   policyType: "V2",
 *   instantRpRetentionRangeInDays: 7,
 *   schedulePolicy: {
 *     schedulePolicyType: "SimpleSchedulePolicyV2",
 *     scheduleRunFrequency: "Hourly",
 *     hourlySchedule: {
 *       interval: 4,
 *       scheduleWindowStartTime: "2026-01-01T08:00:00Z",
 *       scheduleWindowDuration: 16,
 *     },
 *   },
 *   retentionPolicy: {
 *     retentionPolicyType: "LongTermRetentionPolicy",
 *     dailySchedule: {
 *       retentionTimes: ["2026-01-01T08:00:00Z"],
 *       retentionDuration: { count: 30, durationType: "Days" },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const BackupPolicy = Resource<BackupPolicy>(
  "Azure.RecoveryServices.BackupPolicy",
);

type Observed = backup.GetProtectionPolicyResponse;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  policyName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetProtectionPolicy({
      subscriptionId,
      resourceGroupName,
      vaultName,
      policyName,
    }),
  );

/** The policy body Alchemy sends (only fields the user set). */
const desiredProperties = (news: BackupPolicyProps): backup.ProtectionPolicy => {
  const body: Record<string, unknown> = {
    backupManagementType: news.backupManagementType,
    timeZone: news.timeZone ?? "UTC",
  };
  const optional = {
    workLoadType: news.workLoadType,
    policyType: news.policyType,
    schedulePolicy: news.schedulePolicy,
    retentionPolicy: news.retentionPolicy,
    vaultRetentionPolicy: news.vaultRetentionPolicy,
    instantRpRetentionRangeInDays: news.instantRpRetentionRangeInDays,
    tieringPolicy: news.tieringPolicy,
    settings: news.settings,
    subProtectionPolicy: news.subProtectionPolicy,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) body[key] = value;
  }
  // AzureWorkload policies carry the time zone inside `settings`.
  if (news.backupManagementType === "AzureWorkload") delete body.timeZone;
  return body as unknown as backup.ProtectionPolicy;
};

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): BackupPolicy["Attributes"] => ({
  policyName: name,
  vault,
  resourceGroup,
  policyId: observed.id ?? "",
  backupManagementType: observed.properties?.backupManagementType ?? "",
  protectedItemsCount: observed.properties?.protectedItemsCount ?? 0,
});

export const BackupPolicyProvider = () =>
  Provider.succeed(BackupPolicy, {
    stables: ["policyName", "vault", "resourceGroup", "policyId"],

    // Policies live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.policyName.toLowerCase()) ||
        news.backupManagementType.toLowerCase() !==
          output.backupManagementType.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.policyName ?? olds?.name ?? (yield* createBackupName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        vault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, name, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault } = news;
      const name =
        news.name ?? output?.policyName ?? (yield* createBackupName(id));
      const get = getPolicy(subscriptionId, resourceGroup, vault, name);
      const desired = desiredProperties(news);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is a full upsert, so send it only when the
      // policy is missing or its observed settings differ.
      if (
        observed === undefined ||
        !matchesDesired(observed.properties, desired)
      ) {
        yield* backup.ProtectionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
          policyName: name,
          properties: desired,
        });
      }

      // A policy with protected items is updated asynchronously (202): wait
      // until the observed policy reflects the desired settings.
      const fresh = yield* get.pipe(
        Effect.flatMap((policy) =>
          policy !== undefined && matchesDesired(policy.properties, desired)
            ? Effect.succeed(policy)
            : Effect.fail("pending" as const),
        ),
        Effect.retry({
          while: (e) => e === "pending",
          schedule: Schedule.spaced("5 seconds"),
          times: 36,
        }),
        Effect.catchIf(
          (e): e is "pending" => e === "pending",
          () =>
            Effect.fail(
              new ProvisioningTimedOut({
                resource: `backup policy ${name}`,
                state: undefined,
                message: `backup policy ${name} did not converge after 3 minutes`,
              }),
            ),
        ),
      );
      return toAttrs(resourceGroup, vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        policyName: output.policyName,
      };
      // Items referencing the policy are deleted (and waited on) first.
      yield* ignoreNotFound(backup.DeleteProtectionPolicy(where));
      yield* waitUntilGone(
        `backup policy ${output.policyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.policyName,
        ),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.RecoveryServices.BackupProtectedItem",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
