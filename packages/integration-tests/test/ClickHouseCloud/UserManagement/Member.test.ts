import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as users from "@distilled.cloud/clickhouse-cloud/user_management";
import { adopt } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

/** The system "Member" and "Service Reader" roles every organization has. */
const MEMBER = "21111111-1111-1111-9999-000000000006";
const SERVICE_READER = "21111111-1111-1111-9999-000000000007";

// Managing a member's roles needs a second person in the test organization
// (never the owner the tests authenticate for). Set
// CLICKHOUSE_CLOUD_TEST_MEMBER_USER_ID to that member's user ID.
const memberUserId = process.env.CLICKHOUSE_CLOUD_TEST_MEMBER_USER_ID;

test.provider(
  "a user who is not a member fails with MemberNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const error = yield* stack
        .deploy(
          ClickHouseCloud.UserManagement.Member("Nobody", {
            userId: "Google_100000000000000000000",
            assignedRoleIds: [MEMBER],
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ClickHouseCloud.MemberNotFound");
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);

test.provider.skipIf(memberUserId === undefined)(
  "adopt a member, change their roles, give the old roles back on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      const organizationId = yield* ClickHouseCloud.organizationId;
      const roles = Effect.map(
        users.getMember({ organizationId, userId: memberUserId! }),
        ({ result }) => (result?.assignedRoles ?? []).map((r) => r.roleId).sort(),
      );
      const before = yield* roles;
      const member = yield* stack.deploy(
        ClickHouseCloud.UserManagement.Member("Member", {
          userId: memberUserId!,
          assignedRoleIds: [SERVICE_READER],
        }).pipe(adopt(true)),
      );
      expect(member.baselineRoleIds.sort()).toEqual(before);
      expect(yield* roles).toEqual([SERVICE_READER]);
      yield* stack.destroy();
      expect(yield* roles).toEqual(before);
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
