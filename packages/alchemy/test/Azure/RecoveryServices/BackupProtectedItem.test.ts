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
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-item";

type PolicySpec = Omit<
  Azure.RecoveryServices.BackupPolicyProps,
  "resourceGroup" | "vault"
>;

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

const program = (policy: "Short" | "Long") =>
  Effect.gen(function* () {
    const { group, owner } = yield* groupOnly;
    const rg = group.resourceGroupName;
    const account = yield* Azure.Storage.StorageAccount("Files", {
      resourceGroup: rg,
      sku: "Standard_LRS",
    });
    const share = yield* Azure.Storage.FileShare("Share", {
      resourceGroup: rg,
      storageAccount: account.storageAccountName,
    });
    // Both policies stay deployed so switching is an in-place update.
    const short = yield* Azure.RecoveryServices.BackupPolicy("Short", {
      resourceGroup: rg,
      vault: VAULT,
      ...filesPolicy(7),
    });
    const long = yield* Azure.RecoveryServices.BackupPolicy("Long", {
      resourceGroup: rg,
      vault: VAULT,
      ...filesPolicy(30),
    });
    const container = yield* Azure.RecoveryServices.BackupProtectionContainer(
      "Container",
      {
        resourceGroup: rg,
        vault: VAULT,
        sourceResourceId: account.storageAccountId,
        acquireStorageAccountLock: "NotAcquire",
      },
    );
    const item = yield* Azure.RecoveryServices.BackupProtectedItem("Item", {
      resourceGroup: rg,
      vault: VAULT,
      protectedItemType: "AzureFileShareProtectedItem",
      sourceResourceId: account.storageAccountId,
      containerName: container.containerName,
      friendlyName: share.shareName,
      policyId: policy === "Short" ? short.policyId : long.policyId,
    });
    return { group, owner, share, short, long, container, item };
  });

const getItem = (
  resourceGroupName: string,
  containerName: string,
  protectedItemName: string,
) =>
  Effect.gen(function* () {
    return yield* backup.GetProtectedItem({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName: VAULT,
      fabricName: "Azure",
      containerName,
      protectedItemName,
    });
  });

// Cheap (~$0.01: Azure Files backup instance fee pro rata, no snapshots
// taken before the 23:00 schedule) and ~8 minutes, but NOT disposable:
// vaults created today get soft delete `AlwaysON` (irreversible; a soft
// delete state passed at vault creation leaves the vault stuck
// provisioning), so the deleted item stays soft-deleted for 14 days and
// blocks deleting the vault and its resource group until then. Run with
// AZURE_TEST_EXPENSIVE=1 and clean the vault up after the retention.
test.provider.skipIf(!runExpensive)(
  "protect a file share, switch policy, and stop protection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(groupOnly);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      // Create: protect the share with the 7-day policy.
      const created = yield* stack.deploy(program("Short"));
      expect(created.item.friendlyName).toEqual(created.share.shareName);
      expect(created.item.protectedItemName.toLowerCase()).toContain(
        "azurefileshare;",
      );
      const observed = yield* getItem(
        rg,
        created.container.containerName,
        created.item.protectedItemName,
      );
      expect(observed.properties?.policyId?.toLowerCase()).toEqual(
        created.short.policyId.toLowerCase(),
      );

      // In-place: switch to the 30-day policy.
      const updated = yield* stack.deploy(program("Long"));
      expect(updated.item.protectedItemId).toEqual(
        created.item.protectedItemId,
      );
      const reobserved = yield* getItem(
        rg,
        created.container.containerName,
        created.item.protectedItemName,
      );
      expect(reobserved.properties?.policyId?.toLowerCase()).toEqual(
        created.long.policyId.toLowerCase(),
      );

      // Delete: stop protection; the item is gone or soft-deleted.
      yield* stack.deploy(groupOnly);
      const after = yield* getItem(
        rg,
        created.container.containerName,
        created.item.protectedItemName,
      ).pipe(
        Effect.map((item) =>
          item.properties?.isScheduledForDeferredDelete === true
            ? "soft-deleted"
            : "present",
        ),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed("gone"),
        ),
      );
      expect(after).not.toEqual("present");

      // Fails while the soft-deleted item is retained (see above).
      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
