import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const defaultRoleOf = (userId: string) =>
  galaxy.user.getUser({ userId }).pipe(Effect.map((user) => user.defaultRoleId));

test.provider(
  "set a service account's default role and restore the previous one on removal",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const app = (withDefault: "Reporting" | "Etl" | undefined) =>
        Effect.gen(function* () {
          const etl = yield* StarburstGalaxy.Role("Etl", {});
          const reporting = yield* StarburstGalaxy.Role("Reporting", {});
          const account = yield* StarburstGalaxy.ServiceAccount("Pipeline", {
            role: etl.roleId,
            additionalRoles: [reporting.roleId],
          });
          const setting =
            withDefault === undefined
              ? undefined
              : yield* StarburstGalaxy.UserDefaultRole("PipelineDefault", {
                  user: account.serviceAccountId,
                  role: withDefault === "Reporting" ? reporting.roleId : etl.roleId,
                });
          return { etl, reporting, account, setting };
        });

      const set = yield* stack.deploy(app("Reporting"));
      const userId = set.account.serviceAccountId;
      expect(yield* defaultRoleOf(userId)).toBe(set.reporting.roleId);
      expect(set.setting?.baselineRoleId).toBe(set.etl.roleId);

      // The role updates in place; the baseline stays the first one seen.
      const back = yield* stack.deploy(app("Etl"));
      expect(yield* defaultRoleOf(userId)).toBe(back.etl.roleId);
      expect(back.setting?.baselineRoleId).toBe(set.etl.roleId);
      const again = yield* stack.deploy(app("Reporting"));
      expect(yield* defaultRoleOf(userId)).toBe(again.reporting.roleId);

      // Removing the setting restores the user's own default.
      yield* stack.deploy(app(undefined));
      expect(yield* defaultRoleOf(userId)).toBe(set.etl.roleId);

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:user", "live"],
    timeout: 180_000,
  },
);
