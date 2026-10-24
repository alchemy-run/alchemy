import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { logLevel, policyStack, subscription, tags } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

// A full lifecycle needs two or more VMs sharing a Premium SSD shared disk
// (`maxShares` >= 2). Alchemy has no managed disk resource or VM data-disk
// attachment to build that, so only the rejection is tested.

// Ungated probe (free, ~6 minutes): without any cluster nodes Azure rejects
// the cluster with a typed error.
test.provider(
  "a protection cluster without nodes is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, primary, primaryContainer, policy } = yield* stack.deploy(policyStack);
      const result = yield* asr
        .CreateReplicationProtectionCluster({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          resourceName: vault.vaultName,
          fabricName: primary.fabricName,
          protectionContainerName: primaryContainer.protectionContainerName,
          replicationProtectionClusterName: "alchemy-probe-cluster",
          properties: {
            protectionClusterType: "SharedDisk",
            policyId: policy.policyId,
            providerSpecificDetails: {
              instanceType: "A2A",
              multiVmGroupName: "alchemy-probe-cluster",
            },
            clusterProtectedItemIds: [],
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toEqual("SiteRecoveryOperationNotStarted");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
