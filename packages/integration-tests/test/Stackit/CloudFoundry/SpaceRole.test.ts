import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import * as Effect from "effect/Effect";
import { logLevel, makeStackitTest, stackitTags } from "../helpers.ts";
import { asManager, expectGone } from "./helpers.ts";

const { test } = makeStackitTest();

const options = { tags: stackitTags("cloudfoundry", "spacerole"), timeout: 1_500_000 } as const;

test.provider(
  "grant, change and revoke a space role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (type: Stackit.CloudFoundry.SpaceRoleType) =>
        Effect.gen(function* () {
          const organization = yield* Stackit.CloudFoundry.Organization("SpaceRoleOrg", {});
          const space = yield* Stackit.CloudFoundry.Space("SpaceRoleSpace", {
            organizationId: organization.organizationId,
            forceDestroy: true,
          });
          const manager = yield* Stackit.CloudFoundry.OrganizationManager("SpaceRoleManager", {
            organizationId: organization.organizationId,
          });
          const role = yield* Stackit.CloudFoundry.SpaceRole("SpaceRole", {
            organizationId: organization.organizationId,
            spaceId: space.spaceId,
            type,
            userGuid: manager.userId,
            credentials: {
              apiUrl: manager.apiUrl,
              username: manager.username,
              password: manager.password,
            },
          });
          return { manager, space, role };
        });

      const granted = yield* stack.deploy(program("space_developer"));
      const login = granted.manager;
      expect(granted.role.spaceId).toEqual(granted.space.spaceId);
      expect(granted.role.userGuid).toEqual(granted.manager.userId);

      // Out of band: the role is on the platform, in this space.
      const observed = yield* cf.getRole({ guid: granted.role.roleId }).pipe(asManager(login));
      expect(observed.type).toEqual("space_developer");
      expect(observed.relationships?.space?.data?.guid).toEqual(granted.space.spaceId);

      const unchanged = yield* stack.plan(program("space_developer"));
      expect(unchanged.resources.SpaceRole).toMatchObject({ action: "noop" });

      const changed = yield* stack.deploy(program("space_auditor"));
      expect(changed.role.roleId).not.toEqual(granted.role.roleId);
      yield* expectGone(cf.getRole({ guid: granted.role.roleId }).pipe(asManager(login)));

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
