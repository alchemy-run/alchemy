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
  snapshotPolicyName: string,
) =>
  Effect.gen(function* () {
    return yield* netapp.GetSnapshotPolicy({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      snapshotPolicyName,
    });
  });

const program = (props: { keep: number; enabled: boolean }) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const policy = yield* Azure.NetApp.SnapshotPolicy("Nightly", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      dailySchedule: { snapshotsToKeep: props.keep, hour: 2, minute: 30 },
      enabled: props.enabled,
      tags: { env: "test" },
    });
    return { group, account, policy };
  });

// Free (account + policy, ~2 minutes), but free-trial subscriptions cannot
// create NetApp accounts (`NetAppCreationRestricted`, probed in
// Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a snapshot policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, policy } = yield* stack.deploy(
        program({ keep: 7, enabled: true }),
      );
      const get = () =>
        getPolicy(
          group.resourceGroupName,
          account.accountName,
          policy.snapshotPolicyName,
        );
      const observed = yield* get();
      expect(observed.properties.dailySchedule?.snapshotsToKeep).toEqual(7);
      expect(observed.properties.enabled).toEqual(true);
      expect(observed.tags?.env).toEqual("test");

      // In place: retention and enabled flag.
      const updated = yield* stack.deploy(program({ keep: 3, enabled: false }));
      expect(updated.policy.snapshotPolicyId).toEqual(policy.snapshotPolicyId);
      const reobserved = yield* get();
      expect(reobserved.properties.dailySchedule?.snapshotsToKeep).toEqual(3);
      expect(reobserved.properties.enabled).toEqual(false);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
