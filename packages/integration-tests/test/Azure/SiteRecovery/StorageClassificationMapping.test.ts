import * as Azure from "@alchemy.run/azure";
import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { fabricsStack, logLevel, subscription, tags, waitGone } from "./shared.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Storage classifications are discovered from a System Center VMM server
 * registered with a vault, which the test subscription cannot provide on
 * its own. Supply a vault with a registered VMM fabric:
 * - `AZURE_TEST_ASR_VMM_RESOURCE_GROUP`: resource group of the vault
 * - `AZURE_TEST_ASR_VMM_VAULT`: Recovery Services vault name
 * - `AZURE_TEST_ASR_VMM_FABRIC`: name of the registered VMM fabric
 * - `AZURE_TEST_ASR_VMM_CLASSIFICATION`: source storage classification name
 * - `AZURE_TEST_ASR_VMM_TARGETS`: two comma-separated target classification ARM IDs
 */
const external = {
  resourceGroup: process.env.AZURE_TEST_ASR_VMM_RESOURCE_GROUP,
  vault: process.env.AZURE_TEST_ASR_VMM_VAULT,
  fabric: process.env.AZURE_TEST_ASR_VMM_FABRIC,
  classification: process.env.AZURE_TEST_ASR_VMM_CLASSIFICATION,
  targets: (process.env.AZURE_TEST_ASR_VMM_TARGETS ?? "").split(",").filter(Boolean),
};

const getMapping = (props: {
  resourceGroup: string;
  vault: string;
  fabric: string;
  classification: string;
  name: string;
}) =>
  Effect.gen(function* () {
    return yield* asr.GetReplicationStorageClassificationMapping({
      subscriptionId: yield* subscription,
      resourceGroupName: props.resourceGroup,
      resourceName: props.vault,
      fabricName: props.fabric,
      storageClassificationName: props.classification,
      storageClassificationMappingName: props.name,
    });
  });

// Free control-plane object on an externally registered VMM server:
// needs-external-systems, so the lifecycle only runs with AZURE_TEST_PAID=1
// and the variables above. ~2 minutes.
test.provider.skipIf(
  !runPaidOnly ||
    !external.resourceGroup ||
    !external.vault ||
    !external.fabric ||
    !external.classification ||
    external.targets.length < 2,
)(
  "create, replace, and delete a site recovery storage classification mapping",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const base = {
        resourceGroup: external.resourceGroup!,
        vault: external.vault!,
        fabric: external.fabric!,
        classification: external.classification!,
      };
      const program = (target: string) =>
        Azure.SiteRecovery.StorageClassificationMapping("Mapping", {
          resourceGroup: base.resourceGroup,
          vault: base.vault,
          fabric: base.fabric,
          storageClassification: base.classification,
          targetStorageClassificationId: target,
        });

      // Create.
      const created = yield* stack.deploy(program(external.targets[0]!));
      const observed = yield* getMapping({
        ...base,
        name: created.storageClassificationMappingName,
      });
      expect(observed.properties?.targetStorageClassificationId?.toLowerCase()).toEqual(
        external.targets[0]!.toLowerCase(),
      );

      // Replacement: the target classification is immutable.
      const replaced = yield* stack.deploy(program(external.targets[1]!));
      expect(replaced.storageClassificationMappingName).not.toEqual(
        created.storageClassificationMappingName,
      );
      const reobserved = yield* getMapping({
        ...base,
        name: replaced.storageClassificationMappingName,
      });
      expect(reobserved.properties?.targetStorageClassificationId?.toLowerCase()).toEqual(
        external.targets[1]!.toLowerCase(),
      );
      expect(
        yield* waitGone(getMapping({ ...base, name: created.storageClassificationMappingName })),
      ).toEqual("gone");

      // Delete.
      yield* stack.destroy();
      expect(
        yield* waitGone(getMapping({ ...base, name: replaced.storageClassificationMappingName })),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe (free, ~5 minutes): an Azure-to-Azure fabric has no storage
// classifications, so mapping one is rejected with a typed error.
test.provider(
  "a storage classification mapping on an Azure fabric is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, primary, recovery } = yield* stack.deploy(fabricsStack);
      const result = yield* asr
        .CreateReplicationStorageClassificationMapping({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          resourceName: vault.vaultName,
          fabricName: primary.fabricName,
          storageClassificationName: "alchemy-missing-classification",
          storageClassificationMappingName: "alchemy-probe",
          properties: {
            targetStorageClassificationId: `${recovery.fabricId}/replicationStorageClassifications/alchemy-missing-classification`,
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toEqual("InvalidParameter");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
