import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscription,
  tags,
  vaultStack,
  waitGone,
} from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  instanceType: "VMwareToAzStackHCI" | "HyperVToAzStackHCI";
  recoveryPointHistoryInMinutes: number;
}) =>
  Effect.gen(function* () {
    const { group, vault } = yield* vaultStack;
    const policy = yield* Azure.DataReplication.Policy("Policy", {
      resourceGroup: group.resourceGroupName,
      vault: vault.vaultName,
      customProperties: {
        instanceType: props.instanceType,
        recoveryPointHistoryInMinutes: props.recoveryPointHistoryInMinutes,
        crashConsistentFrequencyInMinutes: 60,
        appConsistentFrequencyInMinutes: 240,
      },
    });
    return { group, vault, policy };
  });

const getPolicy = (rg: string, vault: string, policyName: string) =>
  Effect.gen(function* () {
    return yield* dr.GetPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      vaultName: vault,
      policyName,
    });
  });

const customOf = (policy: dr.GetPolicyResponse) =>
  policy.properties?.customProperties as Record<string, unknown>;

// Vault and policies are free; ~5 minutes.
test.provider(
  "create, update, replace, and delete a data replication policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({
          instanceType: "VMwareToAzStackHCI",
          recoveryPointHistoryInMinutes: 4320,
        }),
      );
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      const name = created.policy.policyName;
      const observed = customOf(yield* getPolicy(rg, vault, name));
      expect(observed.instanceType).toEqual("VMwareToAzStackHCI");
      expect(observed.recoveryPointHistoryInMinutes).toEqual(4320);

      // Replace: retention (the service ignores a re-PUT of a policy).
      const updated = yield* stack.deploy(
        program({
          instanceType: "VMwareToAzStackHCI",
          recoveryPointHistoryInMinutes: 2880,
        }),
      );
      expect(updated.policy.policyName).not.toEqual(name);
      expect(yield* waitGone(getPolicy(rg, vault, name))).toEqual("gone");
      expect(
        customOf(yield* getPolicy(rg, vault, updated.policy.policyName))
          .recoveryPointHistoryInMinutes,
      ).toEqual(2880);

      // Replace: instanceType.
      const replaced = yield* stack.deploy(
        program({
          instanceType: "HyperVToAzStackHCI",
          recoveryPointHistoryInMinutes: 2880,
        }),
      );
      expect(
        customOf(yield* getPolicy(rg, vault, replaced.policy.policyName))
          .instanceType,
      ).toEqual("HyperVToAzStackHCI");

      // Delete the policy, keep the vault.
      yield* stack.deploy(vaultStack);
      expect(
        yield* waitGone(getPolicy(rg, vault, replaced.policy.policyName)),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
