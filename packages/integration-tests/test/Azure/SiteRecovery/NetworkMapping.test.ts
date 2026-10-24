import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { fabricsStack, logLevel, PRIMARY, RECOVERY, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Fabrics plus two primary and two recovery virtual networks (all free). */
const networksStack = Effect.gen(function* () {
  const fabrics = yield* fabricsStack;
  const vnet = (id: string, location: string, prefix: string) =>
    Azure.Network.VirtualNetwork(id, {
      resourceGroup: fabrics.group.resourceGroupName,
      location,
      addressPrefixes: [prefix],
    });
  const primaryA = yield* vnet("PrimaryVnetA", PRIMARY, "10.10.0.0/16");
  const primaryB = yield* vnet("PrimaryVnetB", PRIMARY, "10.11.0.0/16");
  const recoveryA = yield* vnet("RecoveryVnetA", RECOVERY, "10.20.0.0/16");
  const recoveryB = yield* vnet("RecoveryVnetB", RECOVERY, "10.21.0.0/16");
  return { ...fabrics, primaryA, primaryB, recoveryA, recoveryB };
});

const program = (props: { primary: "A" | "B"; recovery: "A" | "B" }) =>
  Effect.gen(function* () {
    const base = yield* networksStack;
    const mapping = yield* Azure.SiteRecovery.NetworkMapping("Mapping", {
      ...base.base,
      fabric: base.primary.fabricName,
      primaryNetworkId: (props.primary === "A" ? base.primaryA : base.primaryB).virtualNetworkId,
      recoveryFabric: base.recovery.fabricName,
      recoveryNetworkId: (props.recovery === "A" ? base.recoveryA : base.recoveryB)
        .virtualNetworkId,
    });
    return { ...base, mapping };
  });

const getMapping = (rg: string, vault: string, fabric: string, name: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationNetworkMapping({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      fabricName: fabric,
      networkName: "azureNetwork",
      networkMappingName: name,
    });
  });

// Vault, fabrics, virtual networks, and network mappings are free; ~8 minutes.
test.provider(
  "create, update, replace, and delete a site recovery network mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: primary A -> recovery A.
      const created = yield* stack.deploy(program({ primary: "A", recovery: "A" }));
      const get = (name: string) =>
        getMapping(
          created.group.resourceGroupName,
          created.vault.vaultName,
          created.primary.fabricName,
          name,
        );
      expect(created.mapping.network).toEqual("azureNetwork");
      expect(created.mapping.networkMappingId).toContain(
        `/replicationNetworkMappings/${created.mapping.networkMappingName}`,
      );
      const observed = yield* get(created.mapping.networkMappingName);
      expect(observed.properties?.primaryNetworkId?.toLowerCase()).toEqual(
        created.primaryA.virtualNetworkId.toLowerCase(),
      );
      expect(observed.properties?.recoveryNetworkId?.toLowerCase()).toEqual(
        created.recoveryA.virtualNetworkId.toLowerCase(),
      );

      // In place: fail over into recovery network B.
      const updated = yield* stack.deploy(program({ primary: "A", recovery: "B" }));
      expect(updated.mapping.networkMappingId).toEqual(created.mapping.networkMappingId);
      const reobserved = yield* get(created.mapping.networkMappingName);
      expect(reobserved.properties?.recoveryNetworkId?.toLowerCase()).toEqual(
        created.recoveryB.virtualNetworkId.toLowerCase(),
      );

      // Replacement: the primary network is immutable.
      const replaced = yield* stack.deploy(program({ primary: "B", recovery: "A" }));
      expect(replaced.mapping.networkMappingName).not.toEqual(created.mapping.networkMappingName);
      const remapped = yield* get(replaced.mapping.networkMappingName);
      expect(remapped.properties?.primaryNetworkId?.toLowerCase()).toEqual(
        created.primaryB.virtualNetworkId.toLowerCase(),
      );
      expect(yield* waitGone(get(created.mapping.networkMappingName))).toEqual("gone");

      // Delete.
      yield* stack.deploy(networksStack);
      expect(yield* waitGone(get(replaced.mapping.networkMappingName))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
