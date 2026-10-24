import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, policyStack, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/** Policy stack plus a second recovery container to re-target the mapping at. */
const baseStack = Effect.gen(function* () {
  const base = yield* policyStack;
  const otherRecoveryContainer = yield* Azure.SiteRecovery.ProtectionContainer(
    "OtherRecoveryContainer",
    { ...base.base, fabric: base.recovery.fabricName },
  );
  return { ...base, otherRecoveryContainer };
});

const program = (props: { target: "first" | "other"; agentAutoUpdate: "Enabled" | "Disabled" }) =>
  Effect.gen(function* () {
    const base = yield* baseStack;
    const target =
      props.target === "first" ? base.recoveryContainer : base.otherRecoveryContainer;
    const mapping = yield* Azure.SiteRecovery.ProtectionContainerMapping("Mapping", {
      ...base.base,
      fabric: base.primary.fabricName,
      protectionContainer: base.primaryContainer.protectionContainerName,
      targetProtectionContainerId: target.protectionContainerId,
      policyId: base.policy.policyId,
      providerSpecificInput: {
        instanceType: "A2A",
        agentAutoUpdateStatus: props.agentAutoUpdate,
        ...(props.agentAutoUpdate === "Enabled"
          ? { automationAccountAuthenticationType: "SystemAssignedIdentity" as const }
          : {}),
      },
    });
    return { ...base, mapping };
  });

const getMapping = (
  rg: string,
  vault: string,
  fabric: string,
  container: string,
  mappingName: string,
) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationProtectionContainerMapping({
      subscriptionId: yield* subscription,
      resourceGroupName: rg,
      resourceName: vault,
      fabricName: fabric,
      protectionContainerName: container,
      mappingName,
    });
  });

const detailsOf = (mapping: asr.GetReplicationProtectionContainerMappingResponse) =>
  mapping.properties?.providerSpecificDetails as {
    instanceType?: string;
    agentAutoUpdateStatus?: string;
  };

// Vault, fabrics, containers, policy, and mappings are free ($0/run), but
// pairing takes ~4 minutes per mapping on top of ~3 minutes of fabrics:
// the lifecycle takes ~20 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a site recovery protection container mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create: pair primary -> recovery with agent auto-update off.
      const created = yield* stack.deploy(program({ target: "first", agentAutoUpdate: "Disabled" }));
      const get = (name: string) =>
        getMapping(
          created.group.resourceGroupName,
          created.vault.vaultName,
          created.primary.fabricName,
          created.primaryContainer.protectionContainerName,
          name,
        );
      expect(created.mapping.state).toEqual("Paired");
      expect(created.mapping.targetProtectionContainerId.toLowerCase()).toEqual(
        created.recoveryContainer.protectionContainerId.toLowerCase(),
      );
      const observed = yield* get(created.mapping.mappingName);
      expect(observed.properties?.policyId?.toLowerCase()).toEqual(
        created.policy.policyId.toLowerCase(),
      );
      expect(detailsOf(observed).instanceType).toEqual("A2A");
      expect(detailsOf(observed).agentAutoUpdateStatus).toEqual("Disabled");

      // In place: enable agent auto-update (ASR creates the automation account).
      const updated = yield* stack.deploy(program({ target: "first", agentAutoUpdate: "Enabled" }));
      expect(updated.mapping.mappingId).toEqual(created.mapping.mappingId);
      const reobserved = yield* get(created.mapping.mappingName);
      expect(detailsOf(reobserved).agentAutoUpdateStatus).toEqual("Enabled");

      // Replacement: the target container is immutable.
      const replaced = yield* stack.deploy(program({ target: "other", agentAutoUpdate: "Enabled" }));
      expect(replaced.mapping.targetProtectionContainerId.toLowerCase()).toEqual(
        replaced.otherRecoveryContainer.protectionContainerId.toLowerCase(),
      );
      expect(replaced.mapping.mappingName).not.toEqual(created.mapping.mappingName);
      const retargeted = yield* get(replaced.mapping.mappingName);
      expect(retargeted.properties?.targetProtectionContainerId?.toLowerCase()).toEqual(
        replaced.otherRecoveryContainer.protectionContainerId.toLowerCase(),
      );
      expect(yield* waitGone(get(created.mapping.mappingName))).toEqual("gone");

      // Delete (unpair).
      yield* stack.deploy(baseStack);
      expect(yield* waitGone(get(replaced.mapping.mappingName))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
