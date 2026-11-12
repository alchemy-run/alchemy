import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { freshStack } from "../helpers.ts";
import { expectFound, expectNotFound } from "../lookup.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

test.provider(
  "look up a person by email and a service account by ID; declaring a user is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      // The account's first listed person, read only.
      const person = yield* galaxy.user.listUsers.items({}).pipe(Stream.runHead);
      expect(person._tag).toBe("Some");
      if (person._tag === "Some") {
        yield* expectFound(
          StarburstGalaxy.User.User.lookup({ email: person.value.email.toUpperCase() }),
          {
            userId: person.value.userId,
            email: person.value.email,
          },
        );
      }
      yield* expectNotFound(StarburstGalaxy.User.User.lookup({ email: "nobody@alchemy.invalid" }));

      // A service account is a user found by ID (Galaxy lists only people).
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* StarburstGalaxy.Role.Role("Role", {});
          return yield* StarburstGalaxy.ServiceAccount.ServiceAccount("Account", {
            role: role.roleId,
          });
        }),
      );
      yield* expectFound(StarburstGalaxy.User.User.lookup({ userId: deployed.serviceAccountId }), {
        userId: deployed.serviceAccountId,
        email: deployed.userName,
        defaultRoleId: deployed.roleId,
      });

      const declared = yield* stack
        .deploy(StarburstGalaxy.User.User("Someone", { email: "someone@alchemy.invalid" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(declared)).toBe(true);
      expect(String(Exit.isFailure(declared) && declared.cause)).toContain("can only be looked up");

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:user", "live"],
    timeout: 420_000,
  },
);
