import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as authorization from "@distilled.cloud/stackit/authorization";
import * as serviceAccount from "@distilled.cloud/stackit/service_account";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("iam", "customrole"), timeout: 180_000 } as const;

const ROLE_NAME = /^[a-z](?:[-.]?[a-z]){1,63}$/;

/** Two real permission names, picked deterministically from the catalog. */
const pickPermissions = Effect.gen(function* () {
  const { permissions } = yield* authorization.listPermissions({ resourceType: "project" });
  const names = [...new Set(permissions.map((permission) => permission.name))].sort();
  expect(names.length).toBeGreaterThanOrEqual(2);
  return [names[0]!, names[1]!] as const;
});

/** Out-of-band view of a custom role through the list API. */
const findRole = (projectId: string, roleId: string) =>
  authorization
    .listRoles({ resourceType: "project", resourceId: projectId })
    .pipe(Effect.map((response) => response.roles.find((role) => role.id === roleId)));

const permissionsOf = (role: authorization.Role | undefined) =>
  (role?.permissions ?? []).map((permission) => permission.name).sort();

/** Typed, bounded wait until the role is no longer listed. */
const waitUntilRoleGone = (projectId: string, roleId: string) =>
  findRole(projectId, roleId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (role) => role === undefined,
      times: 15,
    }),
  );

test.provider(
  "create, update permissions and description, rename, and delete a custom role",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();
      const [first, second] = yield* pickPermissions;

      const created = yield* stack.deploy(Stackit.IAM.CustomRole("Role", { permissions: [first] }));
      expect(created.name).toMatch(ROLE_NAME);
      expect(created.description).toEqual(created.name);
      expect(created.permissions).toEqual([first]);
      expect(created.resourceType).toEqual("project");
      expect(created.resourceId).toEqual(projectId);
      expect(created.roleId).toEqual(expect.any(String));

      const fetched = yield* authorization.getRole({
        resourceType: "project",
        resourceId: projectId,
        roleId: created.roleId,
      });
      expect(fetched.role.name).toEqual(created.name);
      expect(permissionsOf(fetched.role)).toEqual([first]);

      // Redeploying unchanged is a no-op.
      const plan = yield* stack.plan(Stackit.IAM.CustomRole("Role", { permissions: [first] }));
      expect(plan.resources.Role).toMatchObject({ action: "noop" });

      // Permissions and description update in place.
      const updated = yield* stack.deploy(
        Stackit.IAM.CustomRole("Role", {
          description: "Alchemy test role",
          permissions: [second, first],
        }),
      );
      expect(updated.roleId).toEqual(created.roleId);
      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("Alchemy test role");
      expect(updated.permissions).toEqual([first, second].sort());
      const refetched = yield* findRole(projectId, created.roleId);
      expect(refetched?.description).toEqual("Alchemy test role");
      expect(permissionsOf(refetched)).toEqual([first, second].sort());

      // Renaming keeps the role id.
      const renamed = yield* stack.deploy(
        Stackit.IAM.CustomRole("Role", {
          name: "alchemy-test-iam-role",
          description: "Alchemy test role",
          permissions: [first],
        }),
      );
      expect(renamed.roleId).toEqual(created.roleId);
      expect(renamed.name).toEqual("alchemy-test-iam-role");
      const renamedRole = yield* findRole(projectId, created.roleId);
      expect(renamedRole?.name).toEqual("alchemy-test-iam-role");
      expect(permissionsOf(renamedRole)).toEqual([first]);

      // Moving the role to another resource replaces it.
      const replacePlan = yield* stack.plan(
        Stackit.IAM.CustomRole("Role", {
          name: "alchemy-test-iam-role",
          description: "Alchemy test role",
          permissions: [first],
          resourceType: "organization",
          resourceId: "00000000-0000-0000-0000-000000000000",
        }),
      );
      expect(replacePlan.resources.Role).toMatchObject({ action: "replace" });

      yield* stack.destroy();
      expect(yield* waitUntilRoleGone(projectId, created.roleId)).toBeUndefined();
    }).pipe(logLevel),
  options,
);

test.provider(
  "grant a custom role through a membership",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();
      const [first] = yield* pickPermissions;

      // Out-of-band subject with a deterministic name.
      const { items } = yield* serviceAccount.listServiceAccounts({ projectId });
      const subject =
        items.find((account) => account.email.startsWith("alc-iam-role-"))?.email ??
        (yield* serviceAccount.createServiceAccount({ projectId, name: "alc-iam-role" })).email;

      yield* Effect.gen(function* () {
        const { role, membership } = yield* stack.deploy(
          Effect.gen(function* () {
            const role = yield* Stackit.IAM.CustomRole("GrantedRole", { permissions: [first] });
            const membership = yield* Stackit.IAM.Membership("Grant", {
              subject,
              role: role.name,
            });
            return { role, membership };
          }),
        );
        expect(membership.role).toEqual(role.name);
        const { members } = yield* authorization.listMembers({
          resourceType: "project",
          resourceId: projectId,
          subject,
        });
        expect(members.map((member) => member.role)).toContain(role.name);

        // Destroy revokes the membership before deleting the role.
        yield* stack.destroy();
        expect(yield* waitUntilRoleGone(projectId, role.roleId)).toBeUndefined();
      }).pipe(
        Effect.ensuring(
          serviceAccount
            .deleteServiceAccount({ projectId, serviceAccountEmail: subject })
            .pipe(Effect.ignore),
        ),
      );
    }).pipe(logLevel),
  options,
);
