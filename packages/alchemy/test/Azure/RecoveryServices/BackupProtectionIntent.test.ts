import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
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

const VAULT = "alchemy-test-rsv-intent";

/**
 * A SQL Server VM registered with the vault (VMAppContainer) that exposes
 * a protectable SQL instance. Not part of this namespace; supply it via
 * env when running the gated test:
 * - AZURE_TEST_BACKUP_SQL_VM_ID: ARM ID of a SQL Server VM in eastus
 * - AZURE_TEST_BACKUP_SQL_INSTANCE_ITEM_ID: protectable SQLInstance item ID
 */
const sqlVmId = process.env.AZURE_TEST_BACKUP_SQL_VM_ID ?? "";
const sqlInstanceItemId =
  process.env.AZURE_TEST_BACKUP_SQL_INSTANCE_ITEM_ID ?? "";

type PolicySpec = Omit<
  Azure.RecoveryServices.BackupPolicyProps,
  "resourceGroup" | "vault"
>;

const sqlPolicy = (days: number): PolicySpec => ({
  backupManagementType: "AzureWorkload",
  workLoadType: "SQLDataBase",
  settings: { timeZone: "UTC", issqlcompression: false },
  subProtectionPolicy: [
    {
      policyType: "Full",
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
    },
  ],
});

const program = (policy: "A" | "B") =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const rg = group.resourceGroupName;
    const a = yield* Azure.RecoveryServices.BackupPolicy("SqlA", {
      resourceGroup: rg,
      vault: VAULT,
      ...sqlPolicy(7),
    });
    const b = yield* Azure.RecoveryServices.BackupPolicy("SqlB", {
      resourceGroup: rg,
      vault: VAULT,
      ...sqlPolicy(30),
    });
    const intent = yield* Azure.RecoveryServices.BackupProtectionIntent(
      "Intent",
      {
        resourceGroup: rg,
        vault: VAULT,
        protectionIntentItemType: "AzureWorkloadSQLAutoProtectionIntent",
        sourceResourceId: sqlVmId,
        itemId: sqlInstanceItemId,
        workloadItemType: "SQLInstance",
        policyId: policy === "A" ? a.policyId : b.policyId,
      },
    );
    return { group, owner, a, b, intent };
  });

const getIntent = (resourceGroupName: string, intentObjectName: string) =>
  Effect.gen(function* () {
    return yield* backup.GetProtectionIntent({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
      fabricName: "Azure",
      intentObjectName,
    });
  });

// Needs a SQL Server VM (marketplace SQL image, >= 2 vCPU, ~$0.20+/hour,
// 15+ minutes to provision and register as a VMAppContainer) — too slow
// and too costly for the trial; run with AZURE_TEST_EXPENSIVE=1 and the
// env vars above.
test.provider.skipIf(!runExpensive || !sqlVmId || !sqlInstanceItemId)(
  "auto-protect a SQL instance, switch policy, and remove the intent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      const created = yield* stack.deploy(program("A"));
      const observed = yield* getIntent(rg, created.intent.intentObjectName);
      expect(observed.properties?.policyId?.toLowerCase()).toEqual(
        created.a.policyId.toLowerCase(),
      );

      yield* stack.deploy(program("B"));
      const reobserved = yield* getIntent(rg, created.intent.intentObjectName);
      expect(reobserved.properties?.policyId?.toLowerCase()).toEqual(
        created.b.policyId.toLowerCase(),
      );

      yield* stack.deploy(groupOnly);
      expect(
        yield* waitGone(getIntent(rg, created.intent.intentObjectName)),
      ).toEqual("gone");

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
