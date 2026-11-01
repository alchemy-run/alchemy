import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, expectGone } from "./helpers.ts";

const { test } = makeStackitTest();

const options = {
  tags: stackitTags("cloudfoundry", "organizationrole"),
  timeout: 1_500_000,
} as const;

test.provider(
  "grant, change and revoke an organization role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (type: Stackit.CloudFoundry.OrganizationRoleType) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("OrgRoleOrg", {});
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("OrgRoleManager", {
            organizationId: organization.organizationId,
          });
          const role = yield* Stackit.CloudFoundry.OrganizationRole("OrgRole", {
            organizationId: organization.organizationId,
            type,
            userGuid: manager.userId,
            credentials: {
              apiUrl: manager.apiUrl,
              username: manager.username,
              password: manager.password,
            },
          });
          return { manager, role };
        });

      const granted = yield* stack.deploy(program("organization_auditor"));
      const login = granted.manager;
      expect(granted.role.type).toEqual("organization_auditor");
      expect(granted.role.userGuid).toEqual(granted.manager.userId);

      // Out of band: the role is on the platform.
      const observed = yield* cf.getRole({ guid: granted.role.roleId }).pipe(asManager(login));
      expect(observed.type).toEqual("organization_auditor");

      const unchanged = yield* stack.plan(program("organization_auditor"));
      expect(unchanged.resources.OrgRole).toMatchObject({ action: "noop" });

      // Changing the role replaces it, and the old one goes.
      const changed = yield* stack.deploy(program("organization_billing_manager"));
      expect(changed.role.roleId).not.toEqual(granted.role.roleId);
      yield* expectGone(cf.getRole({ guid: granted.role.roleId }).pipe(asManager(login)));
      const replaced = yield* cf.getRole({ guid: changed.role.roleId }).pipe(asManager(login));
      expect(replaced.type).toEqual("organization_billing_manager");

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
