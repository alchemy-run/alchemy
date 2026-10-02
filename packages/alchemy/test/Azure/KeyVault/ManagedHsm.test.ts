import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getHsm = (resourceGroupName: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetManagedHsm({
      subscriptionId,
      resourceGroupName,
      name,
    });
  });

const hsmPurged = (location: string, name: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault
      .GetManagedHsmDeleted({ subscriptionId, location, name })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (status) => status === "gone",
          times: 40,
        }),
      );
  });

const program = (tags: Record<string, string>) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const admin = yield* Azure.ManagedIdentity.UserAssignedIdentity("Admin", {
      resourceGroup: group.resourceGroupName,
    });
    const hsm = yield* Azure.KeyVault.ManagedHsm("Hsm", {
      resourceGroup: group.resourceGroupName,
      initialAdminObjectIds: [admin.principalId],
      softDeleteRetentionInDays: 7,
      tags,
    });
    return { group, hsm };
  });

// Standard_B1 is billed ~$3.20/hour until deleted AND purged, and
// provisioning takes 20-30 minutes (plus ~10 minutes to delete and purge):
// roughly $2-3 and 40 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a managed HSM",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ env: "test" }));
      const { group, hsm } = created;
      expect(hsm.hsmUri).toContain(".managedhsm.azure.net");
      expect(hsm.sku).toEqual("Standard_B1");
      const observed = yield* getHsm(
        group.resourceGroupName,
        hsm.managedHsmName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      // In-place update: tags.
      yield* stack.deploy(program({ env: "prod" }));
      const reobserved = yield* getHsm(
        group.resourceGroupName,
        hsm.managedHsmName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* hsmPurged(hsm.location, hsm.managedHsmName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 3_600_000,
  },
);
