import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datashare from "@distilled.cloud/azure/datashare";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (recurrenceInterval: "Hour" | "Day") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.DataShare.Account("Account", {
      resourceGroup: group.resourceGroupName,
    });
    const share = yield* Azure.DataShare.Share("Share", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
    });
    const setting = yield* Azure.DataShare.SynchronizationSetting("Schedule", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      share: share.shareName,
      recurrenceInterval,
      synchronizationTime: "2026-01-01T06:00:00Z",
    });
    return { group, account, share, setting };
  });

// Data Share objects are free; ~2 minutes.
test.provider(
  "create, replace, and delete a synchronization setting",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, share, setting } = yield* stack.deploy(
        program("Day"),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* datashare.GetSynchronizationSettings({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            accountName: account.accountName,
            shareName: share.shareName,
            synchronizationSettingName: name,
          });
        });
      const intervalOf = (s: { properties?: unknown }) =>
        (s.properties as { recurrenceInterval?: string }).recurrenceInterval;
      expect(setting.recurrenceInterval).toEqual("Day");
      expect(
        intervalOf(yield* get(setting.synchronizationSettingName)),
      ).toEqual("Day");

      // Replacement: settings are immutable (one per kind per share).
      const updated = yield* stack.deploy(program("Hour"));
      expect(updated.setting.synchronizationSettingId).not.toEqual(
        setting.synchronizationSettingId,
      );
      expect(updated.setting.recurrenceInterval).toEqual("Hour");
      expect(
        intervalOf(yield* get(updated.setting.synchronizationSettingName)),
      ).toEqual("Hour");
      expect(
        yield* waitGone(get(setting.synchronizationSettingName), 6),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(updated.setting.synchronizationSettingName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
