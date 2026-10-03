import * as Azure from "@/Azure";
import * as Output from "@/Output";
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
 * An extension pairs two working fabrics: a Hyper-V source
 * (`AZURE_DR_HYPERV_SITE_ID`) and an Azure Local target
 * (`AZURE_DR_HCI_SITE_ID`, `AZURE_DR_HCI_CLUSTER_NAME`,
 * `AZURE_DR_HCI_STORAGE_ACCOUNT`) in one Azure Migrate project
 * (`AZURE_DR_MIGRATION_SOLUTION_ID`).
 */
const env = (name: string) => process.env[name] ?? "";

const program = (storageAccountSasSecretName: string) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
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
          storageAccountSasSecretName,
        },
      },
    );
    return { group, vault, extension };
  });

const getExtension = (rg: string, vault: string, name: string) =>
  Effect.gen(function* () {
    return yield* dr.GetReplicationExtension({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      vaultName: vault,
      replicationExtensionName: name,
    });
  });

// Needs an Azure Migrate Hyper-V appliance and an Azure Local cluster,
// which the test subscription does not have. Run with AZURE_TEST_PAID=1
// plus the env vars above.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete a data replication extension",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, extension } = yield* stack.deploy(
        program("alchemysas1"),
      );
      const rg = group.resourceGroupName;
      const observed = yield* getExtension(
        rg,
        vault.vaultName,
        extension.replicationExtensionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      // Replace: the service ignores a re-PUT of an extension.
      const replaced = yield* stack.deploy(program("alchemysas2"));
      expect(replaced.extension.replicationExtensionName).not.toEqual(
        extension.replicationExtensionName,
      );
      expect(
        yield* waitGone(
          getExtension(rg, vault.vaultName, extension.replicationExtensionName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getExtension(
            rg,
            vault.vaultName,
            replaced.extension.replicationExtensionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~2 minutes): with fabrics that do not exist the
// service accepts the PUT and the extension ends in `Failed`.
test.provider(
  "probe: an extension without working fabrics fails to provision",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const subscriptionId = yield* subscription;
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const { group, vault } = yield* vaultStack;
            const fabrics = `/subscriptions/${subscriptionId}/resourceGroups/`;
            const suffix =
              "/providers/Microsoft.DataReplication/replicationFabrics";
            const extension = yield* Azure.DataReplication.ReplicationExtension(
              "Extension",
              {
                resourceGroup: group.resourceGroupName,
                vault: vault.vaultName,
                customProperties: {
                  instanceType: "HyperVToAzStackHCI",
                  hyperVFabricArmId: Output.interpolate`${fabrics}${group.resourceGroupName}${suffix}/nosource`,
                  azStackHciFabricArmId: Output.interpolate`${fabrics}${group.resourceGroupName}${suffix}/notarget`,
                },
              },
            );
            return { group, vault, extension };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Azure.ProvisioningFailed");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
