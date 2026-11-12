import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectGone, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const roleExists = (roleId: string) =>
  galaxy.role.getRole({ roleId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, describe, transfer, rename and delete a role",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const renamed = yield* pinnedName("role");

      const app = (props: StarburstGalaxy.RoleProps, owned = false) =>
        Effect.gen(function* () {
          const owner = yield* StarburstGalaxy.Role("Owner", {});
          const role = yield* StarburstGalaxy.Role("Role", {
            ...props,
            ...(owned ? { owningRole: owner.roleId } : {}),
          });
          return { owner, role };
        });

      const created = yield* stack.deploy(app({}));
      const roleId = created.role.roleId;
      expect(created.role.name).toMatch(/^[a-z0-9_]+$/);
      const live = yield* galaxy.role.getRole({ roleId });
      expect(live.roleName).toBe(created.role.name);

      // Description and owner converge in place.
      const described = yield* stack.deploy(app({ description: "analysts" }, true));
      expect(described.role.roleId).toBe(roleId);
      const describedLive = yield* galaxy.role.getRole({ roleId });
      expect(describedLive.roleDescription).toBe("analysts");
      expect(describedLive.owningRoleId).toBe(described.owner.roleId);

      // A rename keeps the role id.
      const named = yield* stack.deploy(app({ name: renamed, description: "analysts" }, true));
      expect(named.role.roleId).toBe(roleId);
      const renamedLive = yield* galaxy.role.getRole({ roleId });
      expect(renamedLive.roleName).toBe(renamed);

      // Built-in roles are found by lookup and left out of `list`.
      const provider = yield* Provider.findProvider(StarburstGalaxy.Role);
      const admin = yield* provider.lookup!({ name: "accountadmin" });
      expect(admin?.name).toBe("accountadmin");
      const listed = yield* provider.list();
      expect(listed.some((role) => role.roleId === roleId)).toBe(true);
      expect(listed.some((role) => role.name === "accountadmin")).toBe(false);

      yield* stack.destroy();
      yield* expectGone(roleExists(roleId));
      yield* expectGone(roleExists(created.owner.roleId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:role", "live"],
    timeout: 120_000,
  },
);
