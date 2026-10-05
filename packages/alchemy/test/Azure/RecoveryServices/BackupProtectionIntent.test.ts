import * as Azure from "@/Azure";
import { stackAndStage } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  createVault,
  deleteVault,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./vault.ts";

const { test } = Test.make({ providers: Azure.providers() });

const VAULT = "alchemy-test-rsv-intent";

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

/** Checked-in admin password for a VM with no public IP or inbound rules. */
const ADMIN_PASSWORD = Redacted.make("Alchemy-Rsv-Sql-2026!");

/**
 * A SQL Server 2022 Developer VM (marketplace image, free SQL license) on a
 * subnet with default outbound access (the backup extension must reach the
 * Azure Backup service), registered with the vault as a VMAppContainer.
 */
/**
 * Azure Backup only registers VMs whose name and resource group name total
 * at most 84 characters, so the group and the VM get short names.
 */
const shortGroup = Effect.gen(function* () {
  const owner = yield* stackAndStage;
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    name: `alchemy-rsv-intent-${owner.stage}`.slice(0, 70),
    location,
  });
  return { group, owner };
});

const sqlHost = Effect.gen(function* () {
  const { group, owner } = yield* shortGroup;
  const rg = group.resourceGroupName;
  const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
    resourceGroup: rg,
    location,
    addressPrefixes: ["10.0.0.0/16"],
  });
  const subnet = yield* Azure.Network.Subnet("Vms", {
    resourceGroup: rg,
    virtualNetwork: vnet.virtualNetworkName,
    addressPrefix: "10.0.1.0/24",
    defaultOutboundAccess: true,
  });
  const nic = yield* Azure.Network.NetworkInterface("Nic", {
    resourceGroup: rg,
    location,
    ipConfigurations: [{ subnetId: subnet.subnetId }],
  });
  const vm = yield* Azure.Compute.VirtualMachine("SqlVm", {
    resourceGroup: rg,
    name: "rsvsqlvm",
    location,
    vmSize: "Standard_D2as_v4",
    image: {
      publisher: "MicrosoftSQLServer",
      offer: "sql2022-ws2022",
      sku: "sqldev-gen2",
    },
    networkInterfaceIds: [nic.networkInterfaceId],
    computerName: "rsvsqlvm",
    adminUsername: "azureuser",
    adminPassword: ADMIN_PASSWORD,
  });
  const container = yield* Azure.RecoveryServices.BackupProtectionContainer(
    "SqlContainer",
    {
      resourceGroup: rg,
      vault: VAULT,
      containerType: "VMAppContainer",
      workloadType: "SQLDataBase",
      sourceResourceId: vm.virtualMachineId,
    },
  );
  return { group, owner, vm, container };
});

const program = (policy: "A" | "B", sqlInstanceItemId: string) =>
  Effect.gen(function* () {
    const { group, owner, vm, container } = yield* sqlHost;
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
        itemId: sqlInstanceItemId,
        policyId: policy === "A" ? a.policyId : b.policyId,
      },
    );
    return { group, owner, vm, container, a, b, intent };
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

/**
 * Inquire the registered container and wait for SQL discovery to report
 * the default SQL instance as a protectable item; returns its ARM ID.
 */
const discoverSqlInstance = (
  resourceGroupName: string,
  containerName: string,
) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const where = { subscriptionId, resourceGroupName, vaultName: VAULT };
    yield* backup.ProtectionContainersInquire({
      ...where,
      fabricName: "Azure",
      containerName,
      _filter: "workloadType eq 'SQLDataBase'",
    });
    const items = yield* backup
      .ListBackupProtectableItems({
        ...where,
        _filter:
          "backupManagementType eq 'AzureWorkload' and workloadType eq 'SQLDataBase'",
      })
      .pipe(
        Effect.map((page) =>
          (page.value ?? []).filter(
            (item) =>
              item.properties?.protectableItemType === "SQLInstance" &&
              item.id !== undefined,
          ),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (found) => found.length > 0,
          times: 60,
        }),
      );
    expect(items.length).toBeGreaterThan(0);
    return items[0]!.id!;
  });

// A Standard_D2as_v4 Windows VM (~$0.19/hour incl. Windows license, SQL
// Developer is free) plus a free vault for ~40 minutes: ~$0.15 per run.
// Provisioning, container registration, and SQL discovery take ~25 min.
// NOT disposable as of 2026-10: creating the intent configures backup for
// master/model/msdb (the ConfigureBackup jobs finish in ~7 minutes, the
// items stay `IRPending` until their first scheduled backup), and the
// policy switch is still rejected with `BackupProtectionOperationInProgress`
// 30 minutes later. Stopping protection of the auto-protected items leaves
// them soft-deleted for 14 days even without recovery points (vaults can no
// longer disable soft delete, not even ones created with old API
// versions), which blocks unregistering the container and deleting the
// vault until then.
// Skipped: failed in the last live run. BackupProtectionOperationInProgress: Another configure
// protection operation is in progress for this item. Please wait for configuration operation to
// finish or retry after some time.
test.provider.skip(
  "auto-protect a SQL instance, switch policy, and remove the intent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, owner } = yield* stack.deploy(shortGroup);
      const rg = group.resourceGroupName;
      yield* createVault(rg, VAULT, owner);

      const host = yield* stack.deploy(sqlHost);
      expect(host.container.registrationStatus).toEqual("Registered");
      const sqlInstanceItemId = yield* discoverSqlInstance(
        rg,
        host.container.containerName,
      );
      expect(sqlInstanceItemId.toLowerCase()).toContain("sqlinstance;");

      const created = yield* stack.deploy(program("A", sqlInstanceItemId));
      const observed = yield* getIntent(rg, created.intent.intentObjectName);
      expect(observed.properties?.policyId?.toLowerCase()).toEqual(
        created.a.policyId.toLowerCase(),
      );

      const updated = yield* stack.deploy(program("B", sqlInstanceItemId));
      expect(updated.intent.intentObjectName).toEqual(
        created.intent.intentObjectName,
      );
      const reobserved = yield* getIntent(rg, created.intent.intentObjectName);
      expect(reobserved.properties?.policyId?.toLowerCase()).toEqual(
        created.b.policyId.toLowerCase(),
      );

      // Remove the intent; the container stays registered until the VM goes.
      yield* stack.deploy(sqlHost);
      expect(
        yield* waitGone(getIntent(rg, created.intent.intentObjectName)),
      ).toEqual("gone");

      yield* stack.deploy(shortGroup);

      yield* deleteVault(rg, VAULT);
      yield* stack.destroy();
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 3_600_000 },
);
