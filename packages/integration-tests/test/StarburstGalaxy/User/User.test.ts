import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

test.provider(
  "look up a person by email and a service account by ID; declaring a user is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.findProvider(StarburstGalaxy.User);

      // The account's first listed person, read only.
      const person = yield* galaxy.user.listUsers.items({}).pipe(Stream.runHead);
      expect(person._tag).toBe("Some");
      if (person._tag === "Some") {
        const byEmail = yield* provider.lookup!({ email: person.value.email.toUpperCase() });
        expect(byEmail?.userId).toBe(person.value.userId);
        expect(byEmail?.email).toBe(person.value.email);
      }
      expect(yield* provider.lookup!({ email: "nobody@alchemy.invalid" })).toBeUndefined();

      // A service account is a user found by ID (Galaxy lists only people).
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* StarburstGalaxy.Role("Role", {});
          return yield* StarburstGalaxy.ServiceAccount("Account", { role: role.roleId });
        }),
      );
      const asUser = yield* provider.lookup!({ userId: deployed.serviceAccountId });
      expect(asUser?.email).toBe(deployed.userName);
      expect(asUser?.defaultRoleId).toBe(deployed.roleId);
      expect(asUser?.directlyGrantedRoles.map((grant) => grant.roleId)).toEqual([deployed.roleId]);

      const declared = yield* stack
        .deploy(StarburstGalaxy.User("Someone", { email: "someone@alchemy.invalid" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(declared)).toBe(true);
      expect(String(Exit.isFailure(declared) && declared.cause)).toContain("can only be looked up");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:user", "live"],
    timeout: 120_000,
  },
);
