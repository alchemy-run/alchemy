import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProxy = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetDppResourceGuardProxy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
      resourceGuardProxyName: "DppResourceGuardProxy",
    });
  });

const getVault = (resourceGroupName: string, vaultName: string) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetBackupVault({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
    });
  });

const program = (props: { description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const guard = yield* Azure.DataProtection.ResourceGuard("Guard", {
      resourceGroup: group.resourceGroupName,
    });
    const vault = yield* Azure.DataProtection.BackupVault("Vault", {
      resourceGroup: group.resourceGroupName,
    });
    const proxy = yield* Azure.DataProtection.ResourceGuardProxy("Proxy", {
      resourceGroup: group.resourceGroupName,
      backupVault: vault.backupVaultName,
      resourceGuardId: guard.resourceGuardId,
      description: props.description,
    });
    return { group, guard, vault, proxy };
  });

// Resource guard + empty vault + proxy: $0, ~1 minute.
test.provider(
  "create, update, and delete a resource guard proxy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, guard, vault, proxy } = yield* stack.deploy(
        program({ description: "first" }),
      );
      const rg = group.resourceGroupName;
      expect(proxy.resourceGuardProxyName).toEqual("DppResourceGuardProxy");
      expect(proxy.resourceGuardId.toLowerCase()).toEqual(
        guard.resourceGuardId.toLowerCase(),
      );
      const observed = yield* getProxy(rg, vault.backupVaultName);
      expect(
        observed.properties?.resourceGuardResourceId?.toLowerCase(),
      ).toEqual(guard.resourceGuardId.toLowerCase());
      expect(observed.properties?.description).toEqual("first");
      const protectedVault = yield* getVault(rg, vault.backupVaultName);
      expect(protectedVault.properties.isVaultProtectedByResourceGuard).toEqual(
        true,
      );

      // In-place update: description.
      yield* stack.deploy(program({ description: "second" }));
      const reobserved = yield* getProxy(rg, vault.backupVaultName);
      expect(reobserved.properties?.description).toEqual("second");

      yield* stack.destroy();
      expect(yield* waitGone(getVault(rg, vault.backupVaultName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
