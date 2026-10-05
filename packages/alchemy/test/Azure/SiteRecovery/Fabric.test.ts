import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, vaultStack, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (location: string) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const fabric = yield* Azure.SiteRecovery.Fabric("Fabric", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      location,
    });
    return { group, vault, fabric };
  });

const getFabric = (rg: string, vault: string, fabricName: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationFabric({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      fabricName,
    });
  });

// Vault and fabrics are free; each fabric create job takes ~3 minutes.
test.provider(
  "create, replace, and delete a site recovery fabric",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const created = yield* stack.deploy(program("eastus"));
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      expect(created.fabric.location).toEqual("eastus");
      expect(created.fabric.fabricId).toContain(
        `/replicationFabrics/${created.fabric.fabricName}`,
      );
      const observed = yield* getFabric(rg, vault, created.fabric.fabricName);
      expect(
        (observed.properties?.customDetails as { instanceType?: string })
          .instanceType,
      ).toEqual("Azure");
      expect(
        (observed.properties?.customDetails as { location?: string }).location,
      ).toEqual("eastus");

      // No-op redeploy keeps the fabric.
      const same = yield* stack.deploy(program("eastus"));
      expect(same.fabric.fabricId).toEqual(created.fabric.fabricId);

      // Replacement: the region is immutable.
      const replaced = yield* stack.deploy(program("centralus"));
      expect(replaced.fabric.location).toEqual("centralus");
      const reobserved = yield* getFabric(
        rg,
        vault,
        replaced.fabric.fabricName,
      );
      expect(
        (reobserved.properties?.customDetails as { location?: string })
          .location,
      ).toEqual("centralus");
      expect(replaced.fabric.fabricName).not.toEqual(created.fabric.fabricName);
      expect(
        yield* waitGone(getFabric(rg, vault, created.fabric.fabricName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(vaultStack);
      expect(
        yield* waitGone(getFabric(rg, vault, replaced.fabric.fabricName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
