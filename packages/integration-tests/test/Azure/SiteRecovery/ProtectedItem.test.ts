import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive, withVcpus } from "../gates.ts";
import {
  logLevel,
  protectedItemStack,
  replicationStack,
  subscription,
  tags,
  waitGone,
} from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getItem = (where: {
  rg: string;
  vault: string;
  fabric: string;
  container: string;
  name: string;
}) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationProtectedItem({
      subscriptionId: yield* subscription,
      resourceGroupName: where.rg,
      resourceName: where.vault,
      fabricName: where.fabric,
      protectionContainerName: where.container,
      replicatedProtectedItemName: where.name,
    });
  });

// One 1-vCPU VM (~$0.04/hour), a cache storage account, and A2A
// protection (first 31 days free) for ~45 minutes: under $0.50, but
// enabling replication takes well over 10 minutes. ~45 min.
test.provider.skipIf(!runExpensive)(
  "enable, update, and disable replication of a VM with site recovery",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: enable A2A replication of the VM.
      const created = yield* stack.deploy(protectedItemStack("Standard_F1als_v7"));
      const where = {
        rg: created.group.resourceGroupName,
        vault: created.vault.vaultName,
        fabric: created.primary.fabricName,
        container: created.primaryContainer.protectionContainerName,
        name: created.item.protectedItemName,
      };
      expect(created.item.protectedItemId).toContain(
        `/replicationProtectedItems/${created.item.protectedItemName}`,
      );
      const observed = yield* getItem(where);
      expect(observed.properties?.policyId?.toLowerCase()).toEqual(
        created.policy.policyId.toLowerCase(),
      );
      const details = observed.properties?.providerSpecificDetails as {
        instanceType?: string;
        fabricObjectId?: string;
      };
      expect(details.instanceType).toEqual("A2A");
      expect(details.fabricObjectId?.toLowerCase()).toEqual(
        created.vm.virtualMachineId.toLowerCase(),
      );

      // In place: change the failover VM size.
      const updated = yield* stack.deploy(protectedItemStack("Standard_F2als_v7"));
      expect(updated.item.protectedItemId).toEqual(created.item.protectedItemId);
      const reobserved = yield* getItem(where);
      expect(
        (reobserved.properties?.providerSpecificDetails as { recoveryAzureVMSize?: string })
          .recoveryAzureVMSize,
      ).toEqual("Standard_F2als_v7");

      // Delete (disable replication).
      yield* stack.deploy(replicationStack);
      expect(yield* waitGone(getItem(where))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 3_600_000 },
);
