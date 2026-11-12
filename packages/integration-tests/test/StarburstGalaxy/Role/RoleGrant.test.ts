import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const grantsOfRole = (roleId: string) =>
  galaxy.role
    .getRole({ roleId })
    .pipe(
      Effect.map((role) =>
        Object.fromEntries(role.directlyGrantedRoles.map((g) => [g.roleId, g.adminOption])),
      ),
    );

const grantsOfUser = (userId: string) =>
  galaxy.user
    .getUser({ userId })
    .pipe(
      Effect.map((user) =>
        Object.fromEntries(user.directlyGrantedRoles.map((g) => [g.roleId, g.adminOption])),
      ),
    );

test.provider(
  "grant two roles to one role, toggle the admin option, revoke one, and grant to a user",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (opts: { second: boolean; admin: boolean; user: boolean }) =>
        Effect.gen(function* () {
          const reporting = yield* StarburstGalaxy.Role("Reporting", {});
          const ledger = yield* StarburstGalaxy.Role("Ledger", {});
          const analysts = yield* StarburstGalaxy.Role("Analysts", {});
          const first = yield* StarburstGalaxy.RoleGrant("AnalystsReport", {
            role: reporting.roleId,
            principal: { type: "Role", roleId: analysts.roleId },
            adminOption: opts.admin,
          });
          // A second grant on the same principal in the same deploy.
          const second = opts.second
            ? yield* StarburstGalaxy.RoleGrant("AnalystsLedger", {
                role: ledger.roleId,
                principal: { type: "Role", roleId: analysts.roleId },
              })
            : undefined;
          const account = yield* StarburstGalaxy.ServiceAccount("Bot", { role: analysts.roleId });
          const toUser = opts.user
            ? yield* StarburstGalaxy.RoleGrant("BotLedger", {
                role: ledger.roleId,
                principal: {
                  type: "User",
                  userId: StarburstGalaxy.User.lookup({ userId: account.serviceAccountId }).userId,
                },
              })
            : undefined;
          return { reporting, ledger, analysts, first, second, account, toUser };
        });

      const both = yield* stack.deploy(app({ second: true, admin: false, user: false }));
      expect(yield* grantsOfRole(both.analysts.roleId)).toEqual({
        [both.reporting.roleId]: false,
        [both.ledger.roleId]: false,
      });
      expect(both.first.roleName).toBe(both.reporting.name);

      // The admin option updates in place and leaves the sibling grant.
      const admin = yield* stack.deploy(app({ second: true, admin: true, user: false }));
      expect(yield* grantsOfRole(admin.analysts.roleId)).toEqual({
        [both.reporting.roleId]: true,
        [both.ledger.roleId]: false,
      });

      // Removing one grant revokes only that role.
      yield* stack.deploy(app({ second: false, admin: true, user: false }));
      expect(yield* grantsOfRole(both.analysts.roleId)).toEqual({ [both.reporting.roleId]: true });

      // A user principal keeps the grants it already had.
      const user = yield* stack.deploy(app({ second: false, admin: true, user: true }));
      expect(yield* grantsOfUser(user.account.serviceAccountId)).toEqual({
        [both.analysts.roleId]: false,
        [both.ledger.roleId]: false,
      });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:role", "live"],
    timeout: 240_000,
  },
);
