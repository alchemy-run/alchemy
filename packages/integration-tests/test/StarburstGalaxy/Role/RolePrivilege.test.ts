import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

/** The role's direct grants on `catalogId`; Galaxy lists them up to ~5 s stale. */
const grantsOn = (roleId: string, catalogId: string) =>
  galaxy.privilege.listRolePrivileges.items({ roleId, listAllPrivileges: false }).pipe(
    Stream.filter((granted) => granted.entityId === catalogId),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

/** Re-read until `done`, bounded at 20 seconds. */
const settled = <A>(
  read: Effect.Effect<A, unknown, galaxy.StarburstGalaxyOpContext>,
  done: (a: A) => boolean,
) => read.pipe(Effect.repeat({ until: done, schedule: Schedule.spaced("2 seconds"), times: 10 }));

test.provider(
  "grant, change the grant option, deny and revoke a table privilege",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (props: Partial<StarburstGalaxy.RolePrivilegeProps>) =>
        Effect.gen(function* () {
          const role = yield* StarburstGalaxy.Role("Role", {});
          const catalog = yield* StarburstGalaxy.PostgresqlCatalog("Catalog", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "app",
            username: "galaxy",
            password: secret("privilege-catalog"),
            validate: false,
          });
          const privilege = yield* StarburstGalaxy.RolePrivilege("Select", {
            role: role.roleId,
            privilege: "Select",
            entity: {
              kind: "Table",
              catalogId: catalog.catalogId,
              schemaName: "*",
              tableName: "*",
            },
            ...props,
          });
          return { role, catalog, privilege };
        });

      const granted = yield* stack.deploy(app({}));
      const roleId = granted.role.roleId;
      const catalogId = granted.catalog.catalogId;
      expect(granted.privilege.entityKind).toBe("Table");
      expect(granted.privilege.entityId).toBe(catalogId);
      expect(granted.privilege.grantKind).toBe("Allow");
      expect(granted.privilege.grantOption).toBe(false);
      const first = yield* settled(grantsOn(roleId, catalogId), (grants) => grants.length === 1);
      expect(first.map((g) => [g.privilege, g.grantKind, g.grantOption])).toEqual([
        ["Select", "Allow", false],
      ]);

      // The grant option replaces the grant: still exactly one.
      yield* stack.deploy(app({ grantOption: true }));
      const withOption = yield* settled(
        grantsOn(roleId, catalogId),
        (grants) => grants.length === 1 && grants[0]!.grantOption,
      );
      expect(withOption.map((g) => [g.privilege, g.grantKind, g.grantOption])).toEqual([
        ["Select", "Allow", true],
      ]);

      // Deny replaces the allow.
      yield* stack.deploy(app({ grantKind: "Deny" }));
      const denied = yield* settled(
        grantsOn(roleId, catalogId),
        (grants) => grants.length === 1 && grants[0]!.grantKind === "Deny",
      );
      expect(denied.map((g) => [g.privilege, g.grantKind, g.grantOption])).toEqual([
        ["Select", "Deny", false],
      ]);

      // Destroy revokes it; the role goes after its privilege.
      yield* stack.destroy();
      const roleGone = yield* galaxy.role.getRole({ roleId }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(roleGone).toBe(true);
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:privilege", "live"],
    timeout: 180_000,
  },
);
