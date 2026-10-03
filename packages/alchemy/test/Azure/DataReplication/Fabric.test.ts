import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { LOCATION, logLevel, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * A fabric needs a real Azure Migrate project with a registered Hyper-V
 * appliance: `AZURE_DR_HYPERV_SITE_ID` (`Microsoft.OffAzure/HyperVSites`)
 * and `AZURE_DR_MIGRATION_SOLUTION_ID` (the project's Server Migration
 * solution).
 */
const hyperVSiteId = process.env.AZURE_DR_HYPERV_SITE_ID ?? "";
const migrationSolutionId = process.env.AZURE_DR_MIGRATION_SOLUTION_ID ?? "";

const program = (fabricTags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const fabric = yield* Azure.DataReplication.Fabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      customProperties: {
        instanceType: "HyperVMigrate",
        hyperVSiteId,
        migrationSolutionId,
      },
      tags: fabricTags,
    });
    return { group, fabric };
  });

const getFabric = (rg: string, fabricName: string) =>
  Effect.gen(function* () {
    return yield* dr.GetFabric({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      fabricName,
    });
  });

// Fabrics are free but need an Azure Migrate appliance (an on-premises
// Hyper-V host running the appliance VM), which the test subscription
// does not have. Run with AZURE_TEST_PAID=1 plus the env vars above.
test.provider.skipIf(!runPaidOnly)(
  "create, update tags, and delete a data replication fabric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fabric } = yield* stack.deploy(program({ env: "a" }));
      const rg = group.resourceGroupName;
      const observed = yield* getFabric(rg, fabric.fabricName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(fabric.instanceType).toEqual("HyperVMigrate");
      expect(observed.tags?.env).toEqual("a");

      const updated = yield* stack.deploy(program({ env: "b" }));
      expect(updated.fabric.fabricId).toEqual(fabric.fabricId);
      expect((yield* getFabric(rg, fabric.fabricName)).tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(getFabric(rg, fabric.fabricName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, ~1 minute): without a real Azure Migrate site the
// service accepts the PUT, then discards the fabric — GET turns into
// ResourceNotFound instead of the fabric reaching `Succeeded`.
test.provider(
  "probe: a fabric without an Azure Migrate site is discarded",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: LOCATION,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const rg = group.resourceGroupName;
      const scope = `/subscriptions/${subscriptionId}/resourceGroups/${rg}`;
      const accepted = yield* dr.CreateFabric({
        subscriptionId,
        resourceGroupName: rg,
        fabricName: "probefabric",
        location: LOCATION,
        properties: {
          customProperties: {
            instanceType: "HyperVMigrate",
            hyperVSiteId: `${scope}/providers/Microsoft.OffAzure/HyperVSites/nosite`,
            migrationSolutionId: `${scope}/providers/Microsoft.Migrate/MigrateProjects/noproject/Solutions/nosolution`,
          },
        },
      });
      expect(accepted.properties?.provisioningState).toEqual("Creating");
      expect(yield* waitGone(getFabric(rg, "probefabric"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
