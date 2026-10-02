import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, vaultStack, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  recoveryPointHistory: number;
  appConsistentFrequencyInMinutes: number;
}) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const policy = yield* Azure.SiteRecovery.ReplicationPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      name: props.name,
      providerSpecificInput: {
        instanceType: "A2A",
        recoveryPointHistory: props.recoveryPointHistory,
        appConsistentFrequencyInMinutes: props.appConsistentFrequencyInMinutes,
        multiVmSyncStatus: "Enable",
      },
    });
    return { group, vault, policy };
  });

const getDetails = (rg: string, vault: string, policyName: string) =>
  Effect.gen(function* () {
    const policy = yield* asr.GetReplicationPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      policyName,
    });
    return policy.properties?.providerSpecificDetails as {
      instanceType?: string;
      recoveryPointHistory?: number;
      appConsistentFrequencyInMinutes?: number;
      multiVmSyncStatus?: string;
    };
  });

const getPolicy = (rg: string, vault: string, policyName: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      policyName,
    });
  });

// Vault and policies are free; ~3 minutes.
test.provider(
  "create, update, replace, and delete a site recovery replication policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: 24h retention, 4-hourly app-consistent snapshots.
      const created = yield* stack.deploy(
        program({
          recoveryPointHistory: 1440,
          appConsistentFrequencyInMinutes: 240,
        }),
      );
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      expect(created.policy.instanceType).toEqual("A2A");
      expect(created.policy.policyId).toContain(
        `/replicationPolicies/${created.policy.policyName}`,
      );
      const details = yield* getDetails(rg, vault, created.policy.policyName);
      expect(details.instanceType).toEqual("A2A");
      expect(details.recoveryPointHistory).toEqual(1440);
      expect(details.appConsistentFrequencyInMinutes).toEqual(240);
      expect(details.multiVmSyncStatus).toEqual("Enabled");

      // In-place: retention 24h -> 48h, app-consistent 4h -> 2h.
      const updated = yield* stack.deploy(
        program({
          recoveryPointHistory: 2880,
          appConsistentFrequencyInMinutes: 120,
        }),
      );
      expect(updated.policy.policyId).toEqual(created.policy.policyId);
      const newDetails = yield* getDetails(
        rg,
        vault,
        created.policy.policyName,
      );
      expect(newDetails.recoveryPointHistory).toEqual(2880);
      expect(newDetails.appConsistentFrequencyInMinutes).toEqual(120);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-asr-policy-renamed",
          recoveryPointHistory: 2880,
          appConsistentFrequencyInMinutes: 120,
        }),
      );
      expect(replaced.policy.policyName).toEqual("alchemy-asr-policy-renamed");
      expect(
        (yield* getDetails(rg, vault, replaced.policy.policyName))
          .recoveryPointHistory,
      ).toEqual(2880);
      expect(
        yield* waitGone(getPolicy(rg, vault, created.policy.policyName)),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(vaultStack);
      expect(
        yield* waitGone(getPolicy(rg, vault, replaced.policy.policyName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
