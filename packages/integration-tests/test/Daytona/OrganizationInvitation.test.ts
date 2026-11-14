import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

const pending = (organizationId: string, invitationId: string) =>
  organizations.listOrganizationInvitations({ organizationId }).pipe(
    Effect.map((all) => all.find((i) => i.id === invitationId && i.status === "pending")),
    // Destroy deletes the team organization along with its invitations.
    Effect.catchTag("OrganizationNotFound", () => Effect.undefined),
  );

test.provider(
  "invite an email with a custom role, change the role, cancel on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (permissions: Daytona.Permission[]) =>
        stack.deploy(
          Effect.gen(function* () {
            // Daytona refuses invitations to a personal organization.
            const organization = yield* Daytona.Organization("Team", { defaultRegionId: "us" });
            const role = yield* Daytona.OrganizationRole("Invitee", { organization, permissions });
            const other = yield* Daytona.OrganizationRole("Reader", {
              organization,
              permissions: ["read:volumes"],
            });
            const invitation = yield* Daytona.OrganizationInvitation("Invite", {
              organization,
              email: `alchemy-daytona-${stack.stage}@example.com`,
              roles: permissions.length > 1 ? [role, other] : [role],
            });
            return { role, other, invitation };
          }),
        );

      const first = yield* deploy(["write:sandboxes"]);
      expect(first.invitation.status).toEqual("pending");
      const observed = yield* pending(
        first.invitation.organizationId,
        first.invitation.invitationId,
      );
      expect(observed?.assignedRoles.map((r) => r.id)).toEqual([first.role.roleId]);

      const second = yield* deploy(["write:sandboxes", "delete:sandboxes"]);
      expect(second.invitation.invitationId).toEqual(first.invitation.invitationId);
      const after = yield* pending(first.invitation.organizationId, first.invitation.invitationId);
      expect(after?.assignedRoles.map((r) => r.id).sort()).toEqual(
        [second.role.roleId, second.other.roleId].sort(),
      );

      yield* stack.destroy();
      expect(
        yield* pending(first.invitation.organizationId, first.invitation.invitationId),
      ).toBeUndefined();
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
