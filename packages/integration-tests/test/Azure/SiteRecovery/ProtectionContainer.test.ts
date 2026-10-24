import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, PRIMARY, subscription, tags, vaultStack, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Vault plus one A2A fabric (~3 minutes). */
const fabricStack = Effect.gen(function* () {
  const { group, vault } = yield* vaultStack;
  const fabric = yield* Azure.SiteRecovery.Fabric("Primary", {
    resourceGroup: group.resourceGroupName,
    vault: vault.vaultName,
    location: PRIMARY,
  });
  return { group, vault, fabric };
});

const program = (name?: string) =>
  Effect.gen(function* () {
    const base = yield* fabricStack;
    const container = yield* Azure.SiteRecovery.ProtectionContainer("Container", {
      resourceGroup: base.group.resourceGroupName,
      vault: base.vault.vaultName,
      fabric: base.fabric.fabricName,
      name,
    });
    return { ...base, container };
  });

const getContainer = (rg: string, vault: string, fabric: string, name: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationProtectionContainer({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      fabricName: fabric,
      protectionContainerName: name,
    });
  });

// Vault, fabric, and containers are free; ~6 minutes.
test.provider(
  "create, replace, and delete a site recovery protection container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(program());
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      const fabric = created.fabric.fabricName;
      const get = (name: string) => getContainer(rg, vault, fabric, name);
      expect(created.container.protectionContainerId).toContain(
        `/replicationProtectionContainers/${created.container.protectionContainerName}`,
      );
      expect(created.container.protectedItemCount).toEqual(0);
      const observed = yield* get(created.container.protectionContainerName);
      expect(observed.properties?.fabricType).toEqual("Azure");
      expect(observed.properties?.pairingStatus).toEqual("NotPaired");

      // No-op redeploy keeps the container.
      const same = yield* stack.deploy(program());
      expect(same.container.protectionContainerId).toEqual(created.container.protectionContainerId);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(program("alchemy-asr-container-renamed"));
      expect(replaced.container.protectionContainerName).toEqual("alchemy-asr-container-renamed");
      const reobserved = yield* get("alchemy-asr-container-renamed");
      expect(reobserved.properties?.fabricType).toEqual("Azure");
      expect(yield* waitGone(get(created.container.protectionContainerName))).toEqual("gone");

      // Delete.
      yield* stack.deploy(fabricStack);
      expect(yield* waitGone(get("alchemy-asr-container-renamed"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
