import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as keyvault from "@distilled.cloud/azure/keyvault";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getKey = (
  resourceGroupName: string,
  vaultName: string,
  keyName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* keyvault.GetKey({
      subscriptionId,
      resourceGroupName,
      vaultName,
      keyName,
    });
  });

const keyGone = (
  resourceGroupName: string,
  vaultName: string,
  keyName: string,
) =>
  getKey(resourceGroupName, vaultName, keyName).pipe(
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

const program = (keySize: number) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.KeyVault.Vault("Vault", {
      resourceGroup: group.resourceGroupName,
      softDeleteRetentionInDays: 7,
    });
    const key = yield* Azure.KeyVault.Key("Cmk", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      kty: "RSA",
      keySize,
      keyOps: ["wrapKey", "unwrapKey"],
      rotationPolicy: {
        expiryTime: "P1Y",
        lifetimeActions: [{ action: "rotate", timeAfterCreate: "P90D" }],
      },
      tags: { purpose: "cmk" },
    });
    return { group, vault, key };
  });

// Software-protected RSA keys cost $0.03 per 10k operations; no hourly charge.
test.provider(
  "create, replace, and delete a key vault key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program(2048));
      const rg = created.group.resourceGroupName;
      const vaultName = created.vault.vaultName;
      const key = created.key;
      expect(key.kty).toEqual("RSA");
      expect(key.keySize).toEqual(2048);
      expect(key.keyUri).toEqual(
        `https://${vaultName}.vault.azure.net/keys/${key.keyName}`,
      );
      expect(key.keyUriWithVersion).toContain(key.keyUri);
      const observed = yield* getKey(rg, vaultName, key.keyName);
      expect(observed.properties.keySize).toEqual(2048);
      expect([...(observed.properties.keyOps ?? [])].sort()).toEqual([
        "unwrapKey",
        "wrapKey",
      ]);
      expect(
        observed.properties.rotationPolicy?.lifetimeActions?.[0]?.trigger
          ?.timeAfterCreate,
      ).toEqual("P90D");
      expect(observed.tags?.purpose).toEqual("cmk");
      expect(observed.tags?.["alchemy::id"]).toEqual("Cmk");

      // Re-deploying the same props is a no-op.
      const same = yield* stack.deploy(program(2048));
      expect(same.key.keyUriWithVersion).toEqual(key.keyUriWithVersion);

      // ARM cannot change a key: a new key size replaces it.
      const replaced = yield* stack.deploy(program(3072));
      expect(replaced.key.keyName).not.toEqual(key.keyName);
      expect(replaced.key.keySize).toEqual(3072);
      const observedNew = yield* getKey(rg, vaultName, replaced.key.keyName);
      expect(observedNew.properties.keySize).toEqual(3072);

      // Destroying the vault (deleted + purged) removes its keys.
      yield* stack.destroy();
      expect(yield* keyGone(rg, vaultName, key.keyName)).toEqual("gone");
      expect(yield* keyGone(rg, vaultName, replaced.key.keyName)).toEqual(
        "gone",
      );
    }),
  {
    tags: ["provider:azure", "provider:azure:keyvault", "live"],
    timeout: 900_000,
  },
);
