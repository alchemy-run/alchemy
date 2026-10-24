import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive, withVcpus } from "../gates.ts";
import { logLevel, protectedItemStack, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

const manualStep: Azure.SiteRecovery.RecoveryPlanGroupAction = {
  actionName: "verify-dns",
  failoverTypes: ["PlannedFailover", "UnplannedFailover", "TestFailover"],
  failoverDirections: ["PrimaryToRecovery"],
  customDetails: {
    instanceType: "ManualActionDetails",
    description: "Check that DNS points at the recovery region.",
  },
};

/** A protected VM; a recovery plan needs at least one protected item. */
const itemStack = protectedItemStack("Standard_F1als_v7");

const program = (props: { name?: string; withManualStep: boolean }) =>
  Effect.gen(function* () {
    const base = yield* itemStack;
    const plan = yield* Azure.SiteRecovery.RecoveryPlan("Plan", {
      ...base.base,
      name: props.name,
      primaryFabricId: base.primary.fabricId,
      recoveryFabricId: base.recovery.fabricId,
      groups: [
        {
          groupType: "Boot",
          replicationProtectedItems: [{ id: base.item.protectedItemId }],
          ...(props.withManualStep ? { endGroupActions: [manualStep] } : {}),
        },
      ],
    });
    return { ...base, plan };
  });

const getPlan = (rg: string, vault: string, recoveryPlanName: string) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationRecoveryPlan({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      recoveryPlanName,
    });
  });

const groupTypes = (plan: asr.GetReplicationRecoveryPlanResponse) =>
  (plan.properties?.groups ?? []).map((g) => g.groupType);

// Recovery plans are free, but a plan needs a replicating VM: one 1-vCPU
// VM (~$0.04/hour) plus A2A protection (first 31 days free) for ~40
// minutes, under $0.50; enabling replication takes well over 10 minutes.
// ~40 min.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a site recovery recovery plan",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: one boot group with the protected VM.
      const created = yield* stack.deploy(program({ withManualStep: false }));
      const rg = created.group.resourceGroupName;
      const vault = created.vault.vaultName;
      const get = (name: string) => getPlan(rg, vault, name);
      expect(created.plan.recoveryPlanId).toContain(
        `/replicationRecoveryPlans/${created.plan.recoveryPlanName}`,
      );
      expect(created.plan.primaryFabricId.toLowerCase()).toEqual(
        created.primary.fabricId.toLowerCase(),
      );
      const observed = yield* get(created.plan.recoveryPlanName);
      expect(groupTypes(observed)).toEqual(["Shutdown", "Failover", "Boot"]);
      const items = (observed.properties?.groups ?? []).flatMap((g) =>
        (g.replicationProtectedItems ?? []).map((i) => (i.id ?? "").toLowerCase()),
      );
      expect(items).toEqual([created.item.protectedItemId.toLowerCase()]);
      expect(observed.properties?.failoverDeploymentModel).toEqual("ResourceManager");

      // In place: add a manual step after the boot group.
      const updated = yield* stack.deploy(program({ withManualStep: true }));
      expect(updated.plan.recoveryPlanId).toEqual(created.plan.recoveryPlanId);
      const reobserved = yield* get(created.plan.recoveryPlanName);
      const boot = (reobserved.properties?.groups ?? []).find((g) => g.groupType === "Boot");
      expect((boot?.endGroupActions ?? []).map((a) => a.actionName)).toEqual(["verify-dns"]);

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-asr-plan-renamed", withManualStep: true }),
      );
      expect(replaced.plan.recoveryPlanName).toEqual("alchemy-asr-plan-renamed");
      const renamed = yield* get("alchemy-asr-plan-renamed");
      expect(groupTypes(renamed)).toEqual(["Shutdown", "Failover", "Boot"]);
      expect(yield* waitGone(get(created.plan.recoveryPlanName))).toEqual("gone");

      // Delete.
      yield* stack.deploy(itemStack);
      expect(yield* waitGone(get("alchemy-asr-plan-renamed"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(withVcpus(1), logLevel),
  { tags, timeout: 3_600_000 },
);
