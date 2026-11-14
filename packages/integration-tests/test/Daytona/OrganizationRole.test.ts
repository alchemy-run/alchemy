import * as Daytona from "@alchemy.run/daytona";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as organizations from "@distilled.cloud/daytona/organizations";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Daytona.providers() });

const roleIds = (organizationId: string) =>
  organizations
    .listOrganizationRoles({ organizationId })
    .pipe(Effect.map((roles) => roles.map((r) => r.id)));

test.provider(
  "create a role, update its permissions and description in place, delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Daytona.OrganizationRole("Developer", {
          description: "run sandboxes",
          permissions: ["write:sandboxes", "delete:sandboxes"],
        }),
      );
      expect(yield* roleIds(created.organizationId)).toContain(created.roleId);

      const updated = yield* stack.deploy(
        Daytona.OrganizationRole("Developer", {
          description: "run sandboxes and read volumes",
          permissions: ["write:sandboxes", "delete:sandboxes", "read:volumes"],
        }),
      );
      expect(updated.roleId).toEqual(created.roleId);
      const observed = (yield* organizations.listOrganizationRoles({
        organizationId: created.organizationId,
      })).find((r) => r.id === created.roleId);
      expect(observed?.description).toEqual("run sandboxes and read volumes");
      expect([...(observed?.permissions ?? [])].sort()).toEqual([
        "delete:sandboxes",
        "read:volumes",
        "write:sandboxes",
      ]);

      yield* stack.destroy();
      expect(yield* roleIds(created.organizationId)).not.toContain(created.roleId);
    }),
  { tags: ["provider:daytona", "live"], timeout: 120_000 },
);
