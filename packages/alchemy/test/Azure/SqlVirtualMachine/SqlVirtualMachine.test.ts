import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runExpensive, withVcpus } from "../gates.ts";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSqlVm = (resourceGroupName: string, sqlVirtualMachineName: string) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    sqlvm.GetSqlVirtualMachine({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineName,
      _expand: "*",
    }),
  );

/** Checked-in admin password for the throwaway test VM (no public IP). */
const ADMIN_PASSWORD = Redacted.make("Alchemy-Sql-Test-2026!");
// Dv5/DSv5 family quota is 0 and the B-series is capacity-restricted
// (`SkuNotAvailable`) in eastus; DASv4 is a 2-vCPU/8 GiB SCSI size.
const VM_SIZE = process.env.AZURE_TEST_SQLVM_SIZE ?? "Standard_D2as_v4";

const program = (props: {
  dayOfWeek: "Sunday" | "Saturday";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Vms", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const nic = yield* Azure.Network.NetworkInterface("Nic", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      ipConfigurations: [{ subnetId: subnet.subnetId }],
    });
    // SQL Server 2022 Developer on Windows Server 2022: first-party image,
    // no SQL license charge.
    const vm = yield* Azure.Compute.VirtualMachine("Vm", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      vmSize: VM_SIZE,
      image: {
        publisher: "MicrosoftSQLServer",
        offer: "sql2022-ws2022",
        sku: "sqldev-gen2",
      },
      osDiskStorageAccountType: "Premium_LRS",
      networkInterfaceIds: [nic.networkInterfaceId],
      adminUsername: "sqladmin",
      adminPassword: ADMIN_PASSWORD,
      computerName: "alchemysql",
    });
    const sql = yield* Azure.SqlVirtualMachine.SqlVirtualMachine("Sql", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      virtualMachineId: vm.virtualMachineId,
      sqlServerLicenseType: "PAYG",
      autoPatchingSettings: {
        enable: true,
        dayOfWeek: props.dayOfWeek,
        maintenanceWindowStartingHour: 2,
        maintenanceWindowDuration: 60,
      },
      tags: props.tags,
    });
    return { group, vm, sql };
  });

// A 2-vCPU Windows VM with SQL Server Developer (~$0.19/hour) plus a
// Premium SSD for ~40 minutes: ~$0.15 per run. SQL IaaS Agent registration
// waits for first-boot SQL setup (~20 minutes), the settings update takes
// ~15 minutes and unregistering ~2 minutes: ~37 minutes end to end.
test.provider.skipIf(!runExpensive)(
  "register, update, and unregister a SQL virtual machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vm, sql } = yield* stack.deploy(
        program({ dayOfWeek: "Sunday", tags: { env: "test" } }),
      );
      expect(sql.sqlVirtualMachineName).toEqual(vm.virtualMachineName);
      expect(sql.sqlServerLicenseType).toEqual("PAYG");
      const observed = yield* getSqlVm(
        group.resourceGroupName,
        sql.sqlVirtualMachineName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.autoPatchingSettings?.dayOfWeek).toEqual(
        "Sunday",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Sql");

      // In place: patching window and tags.
      const updated = yield* stack.deploy(
        program({ dayOfWeek: "Saturday", tags: { env: "prod" } }),
      );
      expect(updated.sql.sqlVirtualMachineId).toEqual(sql.sqlVirtualMachineId);
      const reobserved = yield* getSqlVm(
        group.resourceGroupName,
        sql.sqlVirtualMachineName,
      );
      expect(reobserved.properties?.autoPatchingSettings?.dayOfWeek).toEqual(
        "Saturday",
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getSqlVm(group.resourceGroupName, sql.sqlVirtualMachineName),
        ),
      ).toEqual("gone");
    }).pipe(withVcpus(2), logLevel),
  { tags, timeout: 3_600_000 },
);

// Ungated probe (free, ~1 minute): registering a VM that does not exist
// fails with a typed not-found and leaves nothing behind.
test.provider(
  "registering a missing virtual machine fails with a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subscriptionId = yield* subscription;
      const program = Effect.gen(function* () {
        const group = yield* Azure.Resources.ResourceGroup("Group", {
          location: LOCATION,
        });
        return { group };
      });
      const { group } = yield* stack.deploy(program);
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const deployed = yield* program;
            yield* Azure.SqlVirtualMachine.SqlVirtualMachine("Sql", {
              resourceGroup: deployed.group.resourceGroupName,
              location: LOCATION,
              virtualMachineId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Compute/virtualMachines/missing`,
            });
            return deployed;
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "NotFound" });
      expect(
        yield* waitGone(getSqlVm(group.resourceGroupName, "missing")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
