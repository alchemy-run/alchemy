import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as workloads from "@distilled.cloud/azure/workloads";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getInstance = (resourceGroupName: string, sapVirtualInstanceName: string) =>
  Effect.gen(function* () {
    return yield* workloads.GetSapVirtualInstance({
      subscriptionId: yield* subscription,
      resourceGroupName,
      sapVirtualInstanceName,
    });
  });

// An existing SAP system to register, e.g. from an ACSS quickstart:
// central services VM ARM id, its SID, and a user-assigned identity with
// the ACSS role on the VMs' resource group.
const CENTRAL_VM_ID = process.env.AZURE_TEST_SAP_CENTRAL_VM_ID;
const SAP_SID = process.env.AZURE_TEST_SAP_SID ?? "S4H";
const SAP_IDENTITY_ID = process.env.AZURE_TEST_SAP_IDENTITY_ID;

const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vis = yield* Azure.Workloads.SapVirtualInstance("Vis", {
      resourceGroup: group.resourceGroupName,
      name: SAP_SID,
      environment: "NonProd",
      sapProduct: "S4HANA",
      configuration: {
        configurationType: "Discovery",
        centralServerVmId: CENTRAL_VM_ID ?? "",
      },
      userAssignedIdentityIds: SAP_IDENTITY_ID ? [SAP_IDENTITY_ID] : undefined,
      tags: { env },
    });
    return { group, vis };
  });

// Registering needs a running SAP system on SAP-certified VM sizes (E/M
// series, dozens of vCPUs) far above the free trial's ~4 vCPU quota.
// Runs only with AZURE_TEST_PAID=1 and AZURE_TEST_SAP_CENTRAL_VM_ID set.
test.provider.skipIf(!runPaidOnly || !CENTRAL_VM_ID)(
  "register, update tags, and delete a Virtual Instance for SAP solutions",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vis } = yield* stack.deploy(program("test"));
      expect(vis.configurationType).toEqual("Discovery");
      expect(vis.state).toEqual("RegistrationComplete");
      const observed = yield* getInstance(group.resourceGroupName, SAP_SID);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.vis.sapVirtualInstanceId).toEqual(vis.sapVirtualInstanceId);
      const reobserved = yield* getInstance(group.resourceGroupName, SAP_SID);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* waitGone(getInstance(group.resourceGroupName, SAP_SID)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~3 minutes): ARM accepts a Discovery registration
// for a VM that does not exist, then discovery fails. The provider surfaces
// `Azure.ProvisioningFailed` with the recorded `DiscoveryFailed` state
// instead of hanging, and destroy removes the failed instance.
test.provider(
  "registering a missing SAP system fails with a typed provisioning error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: "eastus",
            });
            const vis = yield* Azure.Workloads.SapVirtualInstance("Vis", {
              resourceGroup: group.resourceGroupName,
              name: "X01",
              environment: "NonProd",
              sapProduct: "S4HANA",
              configuration: {
                configurationType: "Discovery",
                centralServerVmId: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Compute/virtualMachines/missing`,
              },
            });
            return { group, vis };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Azure.ProvisioningFailed");
      expect(JSON.stringify(error)).toContain(
        "DiscoveryFailed",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getInstance(group.resourceGroupName, "X01"), 12),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
