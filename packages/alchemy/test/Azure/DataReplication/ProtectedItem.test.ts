import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  LOCATION,
  logLevel,
  subscription,
  tags,
  vaultStack,
  waitGone,
} from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Protecting a machine needs a full Hyper-V → Azure Local setup: source and
 * target fabrics (see ReplicationExtension.test.ts) plus a discovered
 * machine and target placement, passed as a JSON object of
 * `HyperVToAzStackHCI` custom properties in `AZURE_DR_PROTECTED_ITEM_JSON`.
 */
const env = (name: string) => process.env[name] ?? "";
const machine = (): Record<string, unknown> =>
  JSON.parse(env("AZURE_DR_PROTECTED_ITEM_JSON") || "{}");

const program = (targetVmName: string) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const policy = yield* Azure.DataReplication.Policy("Policy", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      customProperties: {
        instanceType: "HyperVToAzStackHCI",
        recoveryPointHistoryInMinutes: 4320,
        crashConsistentFrequencyInMinutes: 60,
        appConsistentFrequencyInMinutes: 240,
      },
    });
    const source = yield* Azure.DataReplication.Fabric("Source", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      customProperties: {
        instanceType: "HyperVMigrate",
        hyperVSiteId: env("AZURE_DR_HYPERV_SITE_ID"),
        migrationSolutionId: env("AZURE_DR_MIGRATION_SOLUTION_ID"),
      },
    });
    const target = yield* Azure.DataReplication.Fabric("Target", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      customProperties: {
        instanceType: "AzStackHCI",
        azStackHciSiteId: env("AZURE_DR_HCI_SITE_ID"),
        migrationSolutionId: env("AZURE_DR_MIGRATION_SOLUTION_ID"),
        cluster: {
          clusterName: env("AZURE_DR_HCI_CLUSTER_NAME"),
          resourceName: env("AZURE_DR_HCI_CLUSTER_NAME"),
          storageAccountName: env("AZURE_DR_HCI_STORAGE_ACCOUNT"),
          storageContainers: [],
        },
      },
    });
    const extension = yield* Azure.DataReplication.ReplicationExtension(
      "Extension",
      {
        resourceGroup: group.resourceGroupName,
        vault: vault.vaultName,
        customProperties: {
          instanceType: "HyperVToAzStackHCI",
          hyperVFabricArmId: source.fabricId,
          azStackHciFabricArmId: target.fabricId,
        },
      },
    );
    const item = yield* Azure.DataReplication.ProtectedItem("Item", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      policyName: policy.policyName,
      replicationExtensionName: extension.replicationExtensionName,
      customProperties: {
        instanceType: "HyperVToAzStackHCI",
        ...machine(),
        targetVmName,
      },
      forceDelete: true,
    });
    return { group, vault, item };
  });

const getItem = (rg: string, vault: string, name: string) =>
  Effect.gen(function* () {
    return yield* dr.GetProtectedItem({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      vaultName: vault,
      protectedItemName: name,
    });
  });

// Needs an on-premises Hyper-V appliance with a discovered VM and an Azure
// Local cluster, which the test subscription does not have; replication
// is billed per protected instance (~$25/month). Run with
// AZURE_TEST_PAID=1 plus the env vars above.
test.provider.skipIf(!runPaidOnly)(
  "protect, update, and unprotect a machine",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, item } = yield* stack.deploy(program("alchemyvm1"));
      const rg = group.resourceGroupName;
      const observed = yield* getItem(
        rg,
        vault.vaultName,
        item.protectedItemName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // In place: target VM name.
      const updated = yield* stack.deploy(program("alchemyvm2"));
      expect(updated.item.protectedItemId).toEqual(item.protectedItemId);
      const custom = (yield* getItem(
        rg,
        vault.vaultName,
        item.protectedItemName,
      )).properties?.customProperties as Record<string, unknown>;
      expect(custom.targetVmName).toEqual("alchemyvm2");

      yield* stack.destroy();
      expect(
        yield* waitGone(getItem(rg, vault.vaultName, item.protectedItemName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~2 minutes): protecting a machine through a policy
// and extension that do not exist is rejected by the service with a bare
// 500 InternalServerError (no ARM error code).
test.provider(
  "probe: a protected item requires a policy and replication extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { group, vault } = yield* vaultStack;
            const item = yield* Azure.DataReplication.ProtectedItem("Item", {
              resourceGroup: group.resourceGroupName,
              vault: vault.vaultName,
              policyName: "nopolicy",
              replicationExtensionName: "noextension",
              customProperties: { instanceType: "HyperVToAzStackHCI" },
            });
            return { group, vault, item };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("InternalServerError");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
