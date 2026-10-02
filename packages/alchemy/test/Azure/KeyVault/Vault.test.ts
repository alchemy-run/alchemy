import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetVault({
      subscriptionId,
      resourceGroupName,
      vaultName,
    });
  });

/** Gone means deleted AND purged (no soft-deleted vault holds the name). */
const vaultPurged = (location: string, vaultName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault
      .GetVaultDeleted({ subscriptionId, location, vaultName })
      .pipe(
        Effect.as("found" as const),
        Effect.catchTag(["ResourceNotFound", "NotFound"], () =>
          Effect.succeed("gone" as const),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (status) => status === "gone",
          times: 24,
        }),
      );
  });

const vaultGone = (resourceGroupName: string, vaultName: string) =>
  getVault(resourceGroupName, vaultName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  location: string;
  tags: Record<string, string>;
  enabledForDeployment: boolean;
  defaultAction: "Allow" | "Deny";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.KeyVault.Vault("Secrets", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      softDeleteRetentionInDays: 7,
      enabledForDeployment: props.enabledForDeployment,
      networkAcls: {
        defaultAction: props.defaultAction,
        ipRules: ["203.0.113.0/24"],
      },
      tags: props.tags,
    });
    return { group, vault };
  });

// Key Vault has no hourly charge; a few operations cost well under $0.01.
test.provider(
  "create, update, replace, and delete a key vault",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "test" },
          enabledForDeployment: false,
          defaultAction: "Allow",
        }),
      );
      const { group, vault } = created;
      expect(vault.vaultName).toMatch(/^[a-z][a-z0-9]{2,23}$/);
      expect(vault.vaultUri).toEqual(
        `https://${vault.vaultName}.vault.azure.net/`,
      );
      expect(vault.enableRbacAuthorization).toEqual(true);
      expect(vault.softDeleteRetentionInDays).toEqual(7);
      const observed = yield* getVault(
        group.resourceGroupName,
        vault.vaultName,
      );
      expect(observed.properties.provisioningState).toEqual("Succeeded");
      expect(observed.properties.sku.name).toEqual("standard");
      expect(observed.properties.enableRbacAuthorization).toEqual(true);
      expect(observed.properties.networkAcls?.ipRules?.[0]?.value).toEqual(
        "203.0.113.0/24",
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Secrets");

      // In-place update: tags, a flag, and the firewall default action.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "prod" },
          enabledForDeployment: true,
          defaultAction: "Deny",
        }),
      );
      expect(updated.vault.vaultName).toEqual(vault.vaultName);
      const reobserved = yield* getVault(
        group.resourceGroupName,
        vault.vaultName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties.enabledForDeployment).toEqual(true);
      expect(reobserved.properties.networkAcls?.defaultAction).toEqual("Deny");

      // Replacement: a new location creates a new vault and purges the old.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "prod" },
          enabledForDeployment: true,
          defaultAction: "Deny",
        }),
      );
      expect(replaced.vault.vaultName).not.toEqual(vault.vaultName);
      expect(replaced.vault.location).toEqual("westus2");
      expect(
        yield* vaultGone(group.resourceGroupName, vault.vaultName),
      ).toEqual("gone");
      expect(yield* vaultPurged("eastus", vault.vaultName)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* vaultGone(group.resourceGroupName, replaced.vault.vaultName),
      ).toEqual("gone");
      expect(yield* vaultPurged("westus2", replaced.vault.vaultName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
