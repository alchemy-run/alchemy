import * as Azure from "@alchemy.run/azure";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
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

const fileShareOf = (policy: backup.ProtectionPolicy | undefined) =>
  policy?.backupManagementType === "AzureStorage" ? policy : undefined;

const iaasVmOf = (policy: backup.ProtectionPolicy | undefined) =>
  policy?.backupManagementType === "AzureIaasVM" ? policy : undefined;

const dailyRetentionOf = (policy: backup.ProtectionPolicy | undefined) => {
  const retention = fileShareOf(policy)?.retentionPolicy;
  return retention?.retentionPolicyType === "LongTermRetentionPolicy"
    ? retention.dailySchedule
    : undefined;
};

const VAULT = "alchemy-test-rsv-policy";

type PolicySpec = Omit<Azure.RecoveryServices.BackupPolicyProps, "resourceGroup" | "vault">;

const filesPolicy = (days: number): PolicySpec => ({
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
});

const vmPolicy: PolicySpec = {
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
};

const program = (policy: PolicySpec) =>
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
      expect(created.policy.policyId).toContain(`/backupPolicies/${created.policy.policyName}`);
      const observed = yield* getPolicy(rg, created.policy.policyName);
      expect(dailyRetentionOf(observed.properties)?.retentionDuration?.count).toEqual(7);
      expect(fileShareOf(observed.properties)?.workLoadType).toEqual("AzureFileShare");

      // In-place: retention 7 -> 14 days.
      const updated = yield* stack.deploy(program(filesPolicy(14)));
      expect(updated.policy.policyId).toEqual(created.policy.policyId);
      const reobserved = yield* getPolicy(rg, created.policy.policyName);
      expect(dailyRetentionOf(reobserved.properties)?.retentionDuration?.count).toEqual(14);

      // Replacement: the workload family is immutable.
      const replaced = yield* stack.deploy(program(vmPolicy));
      expect(replaced.policy.policyName).not.toEqual(created.policy.policyName);
      const vm = yield* getPolicy(rg, replaced.policy.policyName);
      expect(vm.properties?.backupManagementType).toEqual("AzureIaasVM");
      expect(iaasVmOf(vm.properties)?.policyType).toEqual("V2");
      expect(iaasVmOf(vm.properties)?.instantRpRetentionRangeInDays).toEqual(7);
      expect(yield* waitGone(getPolicy(rg, created.policy.policyName))).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(yield* waitGone(getPolicy(rg, replaced.policy.policyName))).toEqual("gone");

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
