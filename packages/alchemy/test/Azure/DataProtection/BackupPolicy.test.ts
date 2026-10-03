import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  BLOB_DATASOURCE,
  blobRetention,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const DISK_DATASOURCE = "Microsoft.Compute/disks";

const getPolicy = (
  resourceGroupName: string,
  vaultName: string,
  backupPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* dataprotection.GetBackupPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      vaultName,
      backupPolicyName,
    });
  });

const diskRules = (
  duration: string,
): Azure.DataProtection.BackupPolicyRule[] => [
  {
    objectType: "AzureBackupRule",
    name: "BackupDaily",
    dataStore: {
      dataStoreType: "OperationalStore",
      objectType: "DataStoreInfoBase",
    },
    backupParameters: {
      objectType: "AzureBackupParams",
      backupType: "Incremental",
    },
    trigger: {
      objectType: "ScheduleBasedTriggerContext",
      schedule: {
        repeatingTimeIntervals: ["R/2024-01-01T02:00:00+00:00/P1D"],
      },
      taggingCriteria: [
        {
          isDefault: true,
          tagInfo: { tagName: "Default" },
          taggingPriority: 99,
        },
      ],
    },
  },
  {
    objectType: "AzureRetentionRule",
    name: "Default",
    isDefault: true,
    lifecycles: [
      {
        deleteAfter: { objectType: "AbsoluteDeleteOption", duration },
        sourceDataStore: {
          dataStoreType: "OperationalStore",
          objectType: "DataStoreInfoBase",
        },
      },
    ],
  },
];

const program = (props: { kind: "blob" | "disk"; duration: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vault = yield* Azure.DataProtection.BackupVault("Vault", {
      resourceGroup: group.resourceGroupName,
    });
    const policy = yield* Azure.DataProtection.BackupPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      backupVault: vault.backupVaultName,
      datasourceTypes: [
        props.kind === "blob" ? BLOB_DATASOURCE : DISK_DATASOURCE,
      ],
      policyRules:
        props.kind === "blob"
          ? blobRetention(props.duration)
          : diskRules(props.duration),
    });
    return { group, vault, policy };
  });

const retentionOf = (policy: dataprotection.GetBackupPolicyResponse) =>
  (
    policy.properties?.policyRules as
      | Array<{
          objectType: string;
          lifecycles?: Array<{ deleteAfter: { duration: string } }>;
        }>
      | undefined
  )?.find((rule) => rule.objectType === "AzureRetentionRule")?.lifecycles?.[0]
    ?.deleteAfter.duration;

// Empty vault + policies: $0, ~1 minute.
test.provider(
  "create, update, replace, and delete a backup policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, vault, policy } = yield* stack.deploy(
        program({ kind: "blob", duration: "P7D" }),
      );
      const rg = group.resourceGroupName;
      const vaultName = vault.backupVaultName;
      expect(policy.backupPolicyId).toContain("/backupPolicies/");
      expect(policy.datasourceTypes).toEqual([BLOB_DATASOURCE]);
      const observed = yield* getPolicy(rg, vaultName, policy.backupPolicyName);
      expect(retentionOf(observed)).toEqual("P7D");

      // Policies cannot be updated: a rule change replaces the policy.
      const updated = yield* stack.deploy(
        program({ kind: "blob", duration: "P14D" }),
      );
      expect(updated.policy.backupPolicyName).not.toEqual(
        policy.backupPolicyName,
      );
      const reobserved = yield* getPolicy(
        rg,
        vaultName,
        updated.policy.backupPolicyName,
      );
      expect(retentionOf(reobserved)).toEqual("P14D");
      expect(
        yield* waitGone(getPolicy(rg, vaultName, policy.backupPolicyName)),
      ).toEqual("gone");

      // Re-deploying the same rules is a no-op.
      const again = yield* stack.deploy(
        program({ kind: "blob", duration: "P14D" }),
      );
      expect(again.policy.backupPolicyName).toEqual(
        updated.policy.backupPolicyName,
      );

      // Replacement: data source types are immutable.
      const replaced = yield* stack.deploy(
        program({ kind: "disk", duration: "P7D" }),
      );
      expect(replaced.policy.backupPolicyName).not.toEqual(
        policy.backupPolicyName,
      );
      const disk = yield* getPolicy(
        rg,
        vaultName,
        replaced.policy.backupPolicyName,
      );
      expect(disk.properties?.datasourceTypes).toEqual([DISK_DATASOURCE]);
      expect(retentionOf(disk)).toEqual("P7D");
      expect(
        yield* waitGone(
          getPolicy(rg, vaultName, updated.policy.backupPolicyName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getPolicy(rg, vaultName, replaced.policy.backupPolicyName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
