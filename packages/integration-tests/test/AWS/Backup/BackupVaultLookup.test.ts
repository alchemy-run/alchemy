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
  "BackupVaultLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const vault = yield* AWS.Backup.BackupVault("lookup-target");
    return {
      backupVaultName: vault.backupVaultName.as<string>(),
      backupVaultArn: vault.backupVaultArn.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up backup vault resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { backupVaultName, backupVaultArn } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          return { arn: AWS.Backup.BackupVault.lookup({ backupVaultName }).backupVaultArn };
        },
        {
          arn: backupVaultArn,
        },
      );
      const survivor = yield* backup.describeBackupVault({ BackupVaultName: backupVaultName });
      expect(survivor.BackupVaultArn).toBe(backupVaultArn);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing backup vault fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      const lookups = {
        "missing-vault": AWS.Backup.BackupVault.lookup({ backupVaultName: name }).backupVaultArn,
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

test.provider(
  "a lookup of a backup vault this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.Backup.BackupVault("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-backup-vault-consumer", {
              value: AWS.Backup.BackupVault.lookup({ backupVaultName: attrs.backupVaultName })
                .backupVaultArn,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
