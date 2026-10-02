import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  createVault,
  deleteVault,
  groupOnly,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-policy";

const filesPolicy = (days: number) =>
  ({
    backupManagementType: "AzureStorage",
    workLoadType: "AzureFileShare",
    schedulePolicy: {
      schedulePolicyType: "SimpleSchedulePolicy",
      scheduleRunFrequency: "Daily",
      scheduleRunTimes: ["2026-01-01T23:00:00Z"],
    },
    retentionPolicy: {
      retentionPolicyType: "LongTermRetentionPolicy",
      dailySchedule: {
        retentionTimes: ["2026-01-01T23:00:00Z"],
        retentionDuration: { count: days, durationType: "Days" },
      },
    },
  }) as const;

const vmPolicy = {
  backupManagementType: "AzureIaasVM",
  policyType: "V2",
  instantRpRetentionRangeInDays: 7,
  schedulePolicy: {
    schedulePolicyType: "SimpleSchedulePolicyV2",
    scheduleRunFrequency: "Hourly",
    hourlySchedule: {
      interval: 4,
      scheduleWindowStartTime: "2026-01-01T08:00:00Z",
      scheduleWindowDuration: 16,
    },
  },
  retentionPolicy: {
    retentionPolicyType: "LongTermRetentionPolicy",
    dailySchedule: {
      retentionTimes: ["2026-01-01T08:00:00Z"],
      retentionDuration: { count: 30, durationType: "Days" },
    },
  },
} as const;

const program = (
  policy: ReturnType<typeof filesPolicy> | typeof vmPolicy,
) =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const backupPolicy = yield* Azure.RecoveryServices.BackupPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      vault: VAULT,
      ...policy,
    });
    return { group, owner, policy: backupPolicy };
  });

const getPolicy = (resourceGroupName: string, policyName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetProtectionPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
      policyName,
    });
  });

// The vault and policies are free; ~3 minutes.
test.provider(
  "create, update, replace, and delete a backup policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      // Create: Azure Files policy, 7-day retention.
      const created = yield* stack.deploy(program(filesPolicy(7)));
      expect(created.policy.backupManagementType).toEqual("AzureStorage");
      expect(created.policy.policyId).toContain(
        `/backupPolicies/${created.policy.policyName}`,
      );
      const observed = yield* getPolicy(rg, created.policy.policyName);
      const retention = observed.properties?.retentionPolicy as {
        dailySchedule?: { retentionDuration?: { count?: number } };
      };
      expect(retention.dailySchedule?.retentionDuration?.count).toEqual(7);
      expect(observed.properties?.workLoadType).toEqual("AzureFileShare");

      // In-place: retention 7 -> 14 days.
      const updated = yield* stack.deploy(program(filesPolicy(14)));
      expect(updated.policy.policyId).toEqual(created.policy.policyId);
      const reobserved = yield* getPolicy(rg, created.policy.policyName);
      const newRetention = reobserved.properties?.retentionPolicy as {
        dailySchedule?: { retentionDuration?: { count?: number } };
      };
      expect(newRetention.dailySchedule?.retentionDuration?.count).toEqual(14);

      // Replacement: the workload family is immutable.
      const replaced = yield* stack.deploy(program(vmPolicy));
      expect(replaced.policy.policyName).not.toEqual(
        created.policy.policyName,
      );
      const vm = yield* getPolicy(rg, replaced.policy.policyName);
      expect(vm.properties?.backupManagementType).toEqual("AzureIaasVM");
      expect(vm.properties?.policyType).toEqual("V2");
      expect(vm.properties?.instantRpRetentionRangeInDays).toEqual(7);
      expect(
        yield* waitGone(getPolicy(rg, created.policy.policyName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* waitGone(getPolicy(rg, replaced.policy.policyName)),
      ).toEqual("gone");

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
