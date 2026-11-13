import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as notifications from "@distilled.cloud/clickhouse-cloud/notifications";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

// A member's notification settings belong to that person, so the test needs
// a second member (never the owner the tests authenticate for). Set
// CLICKHOUSE_CLOUD_TEST_MEMBER_USER_ID to that member's user ID.
const memberUserId = process.env.CLICKHOUSE_CLOUD_TEST_MEMBER_USER_ID;

test.provider(
  "a user who is not a member is refused by the API",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const error = yield* stack
        .deploy(
          ClickHouseCloud.Notifications.MemberNotificationSetting("Nobody", {
            userId: "Google_100000000000000000000",
            notifications: ["billing_credit_passed_90pc_threshold"],
            resources: [organizationId],
            channels: ["email"],
            effect: "disabled",
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("NotFound");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(memberUserId === undefined)(
  "mute a notification for a member, then hand the setting back to the default",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const stored = notifications.listMemberNotificationSettings
        .items({ organizationId, userId: memberUserId! })
        .pipe(
          Stream.filter((s) => s.type === "billing_credit_passed_90pc_threshold"),
          Stream.runCollect,
        );
      yield* stack.deploy(
        ClickHouseCloud.Notifications.MemberNotificationSetting("Quiet", {
          userId: memberUserId!,
          notifications: ["billing_credit_passed_90pc_threshold"],
          resources: [organizationId],
          channels: ["email"],
          effect: "disabled",
        }),
      );
      expect(Array.from(yield* stored).map((s) => [s.channelType, s.effect])).toEqual([
        ["email", "disabled"],
      ]);
      yield* stack.destroy();
      expect(Array.from(yield* stored)).toEqual([]);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
