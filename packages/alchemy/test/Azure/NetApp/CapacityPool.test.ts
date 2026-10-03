import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { accountBase, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPool = (
  resourceGroupName: string,
  accountName: string,
  poolName: string,
) =>
  Effect.gen(function* () {
    return yield* netapp.GetPool({
      subscriptionId: yield* subscription,
      resourceGroupName,
      accountName,
      poolName,
    });
  });

const program = (props: {
  sizeTiB: number;
  serviceLevel: Azure.NetApp.NetAppServiceLevel;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, account } = yield* accountBase;
    const pool = yield* Azure.NetApp.CapacityPool("Pool", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      size: props.sizeTiB * Azure.NetApp.TiB,
      serviceLevel: props.serviceLevel,
      tags: props.tags,
    });
    return { group, account, pool };
  });

// 1-2 TiB Standard, then 2 TiB Premium, for ~15 minutes: ~$0.30 per run
// ($0.20/TiB-hour Standard, $0.40 Premium). Free-trial subscriptions cannot
// create NetApp accounts (`NetAppCreationRestricted`, probed in
// Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a capacity pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool } = yield* stack.deploy(
        program({ sizeTiB: 1, serviceLevel: "Standard", tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getPool(group.resourceGroupName, account.accountName, name);
      const observed = yield* get(pool.poolName);
      expect(observed.properties.size).toEqual(Azure.NetApp.TiB);
      expect(observed.properties.serviceLevel).toEqual("Standard");
      expect(observed.properties.qosType).toEqual("Auto");
      expect(observed.tags?.env).toEqual("a");

      // In place: size and tags.
      const updated = yield* stack.deploy(
        program({ sizeTiB: 2, serviceLevel: "Standard", tags: { env: "b" } }),
      );
      expect(updated.pool.capacityPoolId).toEqual(pool.capacityPoolId);
      const reobserved = yield* get(pool.poolName);
      expect(reobserved.properties.size).toEqual(2 * Azure.NetApp.TiB);
      expect(reobserved.tags?.env).toEqual("b");

      // Replacement: service level.
      const replaced = yield* stack.deploy(
        program({ sizeTiB: 2, serviceLevel: "Premium", tags: { env: "b" } }),
      );
      expect(replaced.pool.poolName).not.toEqual(pool.poolName);
      expect(
        (yield* get(replaced.pool.poolName)).properties.serviceLevel,
      ).toEqual("Premium");
      expect(yield* waitGone(get(pool.poolName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.pool.poolName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
