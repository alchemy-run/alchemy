import * as ClickHouseCloud from "@alchemy.run/clickhouse-cloud";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as users from "@distilled.cloud/clickhouse-cloud/user_management";
import * as Effect from "effect/Effect";
import { cleanSlate } from "../fixtures/cleanup.ts";

const { test } = Test.make({ providers: ClickHouseCloud.providers() });

/** The system "Member" and "Service Reader" roles every organization has. */
const MEMBER = "21111111-1111-1111-9999-000000000006";
const SERVICE_READER = "21111111-1111-1111-9999-000000000007";

const getInvitation = (invitationId: string) =>
  Effect.gen(function* () {
    const organizationId = yield* ClickHouseCloud.organizationId;
    return yield* users
      .getInvitation({ organizationId, invitationId })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
  });

test.provider(
  "invite an address, replace the invitation on a role change, withdraw it",
  (stack) =>
    Effect.gen(function* () {
      yield* cleanSlate(stack);
      // example.com (RFC 2606) has no mail exchanger: nobody receives it.
      const email = `alchemy-${stack.stage.toLowerCase()}@example.com`;
      const invite = (roleId: string) =>
        ClickHouseCloud.UserManagement.Invitation("Invite", { email, assignedRoleIds: [roleId] });

      const first = yield* stack.deploy(invite(MEMBER));
      expect(first.email).toEqual(email);
      expect(first.assignedRoles.map((r) => r.roleId)).toEqual([MEMBER]);
      expect((yield* getInvitation(first.invitationId))?.email).toEqual(email);

      const second = yield* stack.deploy(invite(SERVICE_READER));
      expect(second.invitationId).not.toEqual(first.invitationId);
      expect(yield* getInvitation(first.invitationId)).toBeUndefined();
      expect(
        (yield* getInvitation(second.invitationId))?.assignedRoles?.map((r) => r.roleId),
      ).toEqual([SERVICE_READER]);

      yield* stack.destroy();
      expect(yield* getInvitation(second.invitationId)).toBeUndefined();
    }).pipe(Effect.scoped),
  { tags: ["provider:clickhouse-cloud", "live"], timeout: 120_000 },
);
