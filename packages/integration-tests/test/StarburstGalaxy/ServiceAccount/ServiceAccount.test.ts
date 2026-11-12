import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const getAccount = (serviceAccountId: string) =>
  galaxy.serviceAccount.getServiceAccount({ serviceAccountId });

const accountExists = (serviceAccountId: string) =>
  getAccount(serviceAccountId).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create a service account, change its roles, and replace it on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("svc");

      const app = (
        props: Partial<StarburstGalaxy.ServiceAccount.ServiceAccountProps>,
        extra = false,
      ) =>
        Effect.gen(function* () {
          const reader = yield* StarburstGalaxy.Role.Role("Reader", {});
          const writer = yield* StarburstGalaxy.Role.Role("Writer", {});
          const account = yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Account", {
            role: reader.roleId,
            additionalRoles: extra ? [writer.roleId] : [],
            ...props,
          });
          return { reader, writer, account };
        });

      const created = yield* stack.deploy(app({}));
      const accountId = created.account.serviceAccountId;
      const live = yield* getAccount(accountId);
      // Galaxy qualifies the name with the account domain.
      expect(live.userName).toBe(created.account.userName);
      expect(created.account.userName.startsWith(`${created.account.name}@`)).toBe(true);
      expect(live.roleId).toBe(created.reader.roleId);
      expect(live.additionalRoleIds).toEqual([]);
      // Created without an initial password: passwords are their own resource.
      expect(live.passwords).toEqual([]);

      // Roles converge in place.
      const extended = yield* stack.deploy(app({}, true));
      expect(extended.account.serviceAccountId).toBe(accountId);
      const extendedLive = yield* getAccount(accountId);
      expect(extendedLive.additionalRoleIds).toEqual([extended.writer.roleId]);

      // A new user name is a new account; the old one goes.
      const replaced = yield* stack.deploy(app({ name: renamed }, true));
      expect(replaced.account.serviceAccountId).not.toBe(accountId);
      const replacedLive = yield* getAccount(replaced.account.serviceAccountId);
      expect(replaced.account.name).toBe(renamed);
      expect(replacedLive.userName).toBe(replaced.account.userName);
      expect(replacedLive.userName.startsWith(`${renamed}@`)).toBe(true);
      yield* expectGone(accountExists(accountId));

      yield* stack.destroy();
      yield* expectGone(accountExists(replaced.account.serviceAccountId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:service-account", "live"],
    timeout: 420_000,
  },
);
