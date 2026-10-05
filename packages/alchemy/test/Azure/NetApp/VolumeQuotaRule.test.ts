import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as netapp from "@distilled.cloud/azure/netapp";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, volumeBase, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  quotaType: Azure.NetApp.VolumeQuotaType;
  sizeKiB: number;
}) =>
  Effect.gen(function* () {
    const base = yield* volumeBase;
    const rule = yield* Azure.NetApp.VolumeQuotaRule("PerUser", {
      resourceGroup: base.group.resourceGroupName,
      account: base.account.accountName,
      pool: base.pool.poolName,
      volume: base.volume.volumeName,
      quotaType: props.quotaType,
      quotaSizeInKiBs: props.sizeKiB,
    });
    return { ...base, rule };
  });

// 1 TiB Standard pool (~$0.20/hour) for ~25 minutes: ~$0.20 per run.
// Free-trial subscriptions cannot create NetApp accounts
// (`NetAppCreationRestricted`, probed in Account.test.ts).
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a volume quota rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, pool, volume, rule } = yield* stack.deploy(
        program({ quotaType: "DefaultUserQuota", sizeKiB: 1024 * 1024 }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* netapp.GetVolumeQuotaRule({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            poolName: pool.poolName,
            volumeName: volume.volumeName,
            volumeQuotaRuleName: name,
          });
        });
      const observed = yield* get(rule.volumeQuotaRuleName);
      expect(observed.properties?.quotaType).toEqual("DefaultUserQuota");
      expect(observed.properties?.quotaSizeInKiBs).toEqual(1024 * 1024);

      // In place: size.
      const updated = yield* stack.deploy(
        program({ quotaType: "DefaultUserQuota", sizeKiB: 2 * 1024 * 1024 }),
      );
      expect(updated.rule.volumeQuotaRuleId).toEqual(rule.volumeQuotaRuleId);
      expect(
        (yield* get(rule.volumeQuotaRuleName)).properties?.quotaSizeInKiBs,
      ).toEqual(2 * 1024 * 1024);

      // Replacement: quota type.
      const replaced = yield* stack.deploy(
        program({ quotaType: "DefaultGroupQuota", sizeKiB: 2 * 1024 * 1024 }),
      );
      expect(replaced.rule.volumeQuotaRuleName).not.toEqual(
        rule.volumeQuotaRuleName,
      );
      expect(
        (yield* get(replaced.rule.volumeQuotaRuleName)).properties?.quotaType,
      ).toEqual("DefaultGroupQuota");
      expect(yield* waitGone(get(rule.volumeQuotaRuleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.rule.volumeQuotaRuleName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);
