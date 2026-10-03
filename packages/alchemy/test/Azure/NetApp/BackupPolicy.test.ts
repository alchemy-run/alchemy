import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { accountBase, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  accountName: string,
  backupPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* netapp.GetBackupPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      backupPolicyName,
    });
  });

const program = (props: { daily: number; weekly: number }) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const policy = yield* Azure.NetApp.BackupPolicy("Backups", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      dailyBackupsToKeep: props.daily,
      weeklyBackupsToKeep: props.weekly,
      monthlyBackupsToKeep: 0,
    });
    return { group, account, policy };
  });

// Free (account + policy, ~2 minutes), but free-trial subscriptions cannot
// create NetApp accounts (`NetAppCreationRestricted`, probed in
// Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a backup policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, policy } = yield* stack.deploy(
        program({ daily: 7, weekly: 4 }),
      );
      const get = () =>
        getPolicy(
          group.resourceGroupName,
          account.accountName,
          policy.backupPolicyName,
        );
      const observed = yield* get();
      expect(observed.properties.dailyBackupsToKeep).toEqual(7);
      expect(observed.properties.weeklyBackupsToKeep).toEqual(4);
      expect(observed.properties.enabled).toEqual(true);

      // In place: retention counts.
      const updated = yield* stack.deploy(program({ daily: 3, weekly: 2 }));
      expect(updated.policy.backupPolicyId).toEqual(policy.backupPolicyId);
      const reobserved = yield* get();
      expect(reobserved.properties.dailyBackupsToKeep).toEqual(3);
      expect(reobserved.properties.weeklyBackupsToKeep).toEqual(2);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
