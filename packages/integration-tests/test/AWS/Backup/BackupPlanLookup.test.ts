import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as backup from "@distilled.cloud/aws/backup";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:backup", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "BackupPlanLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vault = yield* AWS.Backup.BackupVault("lookup-target-vault");
    const plan = yield* AWS.Backup.BackupPlan("lookup-target", {
      rules: [
        {
          ruleName: "Daily",
          targetBackupVaultName: vault.backupVaultName,
          scheduleExpression: "cron(0 5 ? * * *)",
        },
      ],
    });
    return {
      backupPlanId: plan.backupPlanId.as<string>(),
      backupPlanArn: plan.backupPlanArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up backup plan resolves by id, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { backupPlanId, backupPlanArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.Backup.BackupPlan.lookup({ backupPlanId }).backupPlanArn };
        },
        {
          arn: backupPlanArn,
        },
      );
      const survivor = yield* backup.getBackupPlan({ BackupPlanId: backupPlanId });
      expect(survivor.BackupPlanArn).toBe(backupPlanArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing backup plan fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-plan": AWS.Backup.BackupPlan.lookup({
          backupPlanId: "00000000-0000-0000-0000-000000000000",
        }).backupPlanArn,
      };
      for (const [id, value] of Object.entries(lookups)) {
        yield* expectDeployFails(stack.deploy(AWS.SSM.Parameter(id, { value })), [
          "LookupNotFoundError",
        ]);
      }
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
