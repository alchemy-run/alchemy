import * as AWS from "@/AWS";
import { BackupPlan } from "@/AWS/Backup/BackupPlan.ts";
import { BackupSelection } from "@/AWS/Backup/BackupSelection.ts";
import { BackupVault } from "@/AWS/Backup/BackupVault.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as backup from "@distilled.cloud/aws/backup";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const vaultName = "alchemy-test-backup-vault-lifecycle";

// AWS Backup reports a missing vault as AccessDeniedException, not
// ResourceNotFoundException.
const getVault = backup
  .describeBackupVault({ BackupVaultName: vaultName })
  .pipe(
    Effect.catchTag(
      ["ResourceNotFoundException", "AccessDeniedException"],
      () => Effect.succeed(undefined),
    ),
  );

test.provider(
  "lifecycle: vault + plan + selection, update plan, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create — vault, an IAM role AWS Backup can assume, a plan targeting the
      // vault, and a tag-based selection assigned to that plan.
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* BackupVault("LifecycleVault", {
            backupVaultName: vaultName,
            tags: { env: "test" },
          });
          const role = yield* AWS.IAM.Role("LifecycleBackupRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "backup.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
            ],
          });
          const plan = yield* BackupPlan("LifecyclePlan", {
            rules: [
              {
                ruleName: "DailyBackups",
                targetBackupVaultName: vault.backupVaultName,
                scheduleExpression: "cron(0 5 ? * * *)",
                startWindowMinutes: 60,
                completionWindowMinutes: 180,
                lifecycle: { deleteAfterDays: 30 },
              },
            ],
            tags: { env: "test" },
          });
          const selection = yield* BackupSelection("LifecycleSelection", {
            backupPlanId: plan.backupPlanId,
            iamRoleArn: role.roleArn,
            listOfTags: [
              {
                conditionType: "STRINGEQUALS",
                conditionKey: "aws:ResourceTag/backup",
                conditionValue: "daily",
              },
            ],
          });
          return {
            vaultArn: vault.backupVaultArn,
            planId: plan.backupPlanId,
            planName: plan.backupPlanName,
            selectionId: selection.selectionId,
          };
        }),
      );

      expect(deployed.vaultArn).toContain(`backup-vault:${vaultName}`);

      // Out-of-band verification via distilled.
      const vault = yield* getVault;
      expect(vault?.BackupVaultName).toBe(vaultName);

      const plan = yield* backup.getBackupPlan({
        BackupPlanId: deployed.planId,
      });
      expect(plan.BackupPlan?.BackupPlanName).toBe(deployed.planName);
      expect(plan.BackupPlan?.Rules?.[0]?.RuleName).toBe("DailyBackups");
      expect(plan.BackupPlan?.Rules?.[0]?.Lifecycle?.DeleteAfterDays).toBe(30);

      const selection = yield* backup.getBackupSelection({
        BackupPlanId: deployed.planId,
        SelectionId: deployed.selectionId,
      });
      expect(selection.BackupSelection?.ListOfTags?.[0]?.ConditionKey).toBe(
        "aws:ResourceTag/backup",
      );

      // Vault tags applied.
      const vaultTags = yield* backup.listTags({
        ResourceArn: deployed.vaultArn,
      });
      expect(vaultTags.Tags?.env).toBe("test");

      // Canonical list() coverage.
      const vaultProvider = yield* Provider.findProvider(BackupVault);
      const allVaults = yield* vaultProvider.list();
      expect(allVaults.some((v) => v.backupVaultName === vaultName)).toBe(true);

      // Update the plan in place — change retention and start window.
      yield* stack.deploy(
        Effect.gen(function* () {
          const vault = yield* BackupVault("LifecycleVault", {
            backupVaultName: vaultName,
            tags: { env: "test" },
          });
          const role = yield* AWS.IAM.Role("LifecycleBackupRole", {
            assumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "backup.amazonaws.com" },
                  Action: ["sts:AssumeRole"],
                },
              ],
            },
            managedPolicyArns: [
              "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup",
            ],
          });
          const plan = yield* BackupPlan("LifecyclePlan", {
            rules: [
              {
                ruleName: "DailyBackups",
                targetBackupVaultName: vault.backupVaultName,
                scheduleExpression: "cron(0 6 ? * * *)",
                startWindowMinutes: 120,
                completionWindowMinutes: 360,
                lifecycle: { deleteAfterDays: 60 },
              },
            ],
            tags: { env: "test" },
          });
          yield* BackupSelection("LifecycleSelection", {
            backupPlanId: plan.backupPlanId,
            iamRoleArn: role.roleArn,
            listOfTags: [
              {
                conditionType: "STRINGEQUALS",
                conditionKey: "aws:ResourceTag/backup",
                conditionValue: "daily",
              },
            ],
          });
          return { planId: plan.backupPlanId };
        }),
      );

      const updatedPlan = yield* backup.getBackupPlan({
        BackupPlanId: deployed.planId,
      });
      expect(
        updatedPlan.BackupPlan?.Rules?.[0]?.Lifecycle?.DeleteAfterDays,
      ).toBe(60);
      expect(updatedPlan.BackupPlan?.Rules?.[0]?.CompletionWindowMinutes).toBe(
        360,
      );

      // Destroy — provider recursively deletes and everything is gone.
      yield* stack.destroy();
      const afterVault = yield* getVault;
      expect(afterVault).toBeUndefined();

      // The plan no longer appears in the account listing.
      const planProvider = yield* Provider.findProvider(BackupPlan);
      const remainingPlans = yield* planProvider.list();
      expect(
        remainingPlans.some((p) => p.backupPlanId === deployed.planId),
      ).toBe(false);
    }),
  { timeout: 240_000 },
);
