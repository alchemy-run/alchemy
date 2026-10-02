import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Azure.providers() });

const policiesOf = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const vault = yield* keyvault.GetVault({
      subscriptionId,
      resourceGroupName,
      vaultName,
    });
    return vault.properties.accessPolicies ?? [];
  });

const program = (secrets?: Azure.KeyVault.VaultPermissions["secrets"]) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      enableRbacAuthorization: false,
      softDeleteRetentionInDays: 7,
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("App", {
      resourceGroup: group.resourceGroupName,
    });
    const policy = secrets
      ? yield* Azure.KeyVault.AccessPolicy("AppSecrets", {
          resourceGroup: group.resourceGroupName,
          vault: vault.vaultName,
          objectId: identity.principalId,
          permissions: { secrets },
        })
      : undefined;
    return { group, vault, identity, policy };
  });

// Vault + managed identity: no hourly charge.
test.provider(
  "add, widen, and remove a key vault access policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(["get", "list"]));
      const rg = created.group.resourceGroupName;
      const vaultName = created.vault.vaultName;
      const objectId = created.identity.principalId;
      expect(created.policy!.objectId).toEqual(objectId);
      const find = policiesOf(rg, vaultName).pipe(
        Effect.map((entries) =>
          entries.find((entry) => entry.objectId === objectId),
        ),
      );
      const entry = yield* find;
      expect([...(entry?.permissions.secrets ?? [])].sort()).toEqual([
        "get",
        "list",
      ]);

      // In-place update: converge to exactly the new permission set.
      yield* stack.deploy(program(["get", "set"]));
      const widened = yield* find;
      expect([...(widened?.permissions.secrets ?? [])].sort()).toEqual([
        "get",
        "set",
      ]);

      // Removing the resource removes the entry.
      yield* stack.deploy(program());
      expect(yield* find).toBeUndefined();

      yield* stack.destroy();
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
