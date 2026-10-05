import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, volumeBase, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = Effect.gen(function* () {
  const base = yield* volumeBase;
  const snapshot = yield* Azure.NetApp.Snapshot("Snap", {
    resourceGroup: base.group.resourceGroupName,
    account: base.account.accountName,
    pool: base.pool.poolName,
    volume: base.volume.volumeName,
  });
  return { ...base, snapshot };
});

// 1 TiB Standard pool (~$0.20/hour) for ~20 minutes: ~$0.20 per run.
// Free-trial subscriptions cannot create NetApp accounts
// (`NetAppCreationRestricted`, probed in Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create and delete a volume snapshot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool, volume, snapshot } =
        yield* stack.deploy(program);
      const get = () =>
        Effect.gen(function* () {
          return yield* netapp.GetSnapshot({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            poolName: pool.poolName,
            volumeName: volume.volumeName,
            snapshotName: snapshot.snapshotName,
          });
        });
      expect(snapshot.snapshotUuid).toBeDefined();
      const observed = yield* get();
      expect(observed.properties?.snapshotId).toEqual(snapshot.snapshotUuid);

      // Redeploying an existing snapshot is a no-op.
      const again = yield* stack.deploy(program);
      expect(again.snapshot.snapshotId).toEqual(snapshot.snapshotId);

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
