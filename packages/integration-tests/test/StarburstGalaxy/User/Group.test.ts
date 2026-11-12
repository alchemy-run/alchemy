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
  "groups are looked up by name or ID; declaring a group is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      yield* expectNotFound(StarburstGalaxy.User.Group.lookup({ name: "alchemy-no-such-group" }));
      yield* expectNotFound(StarburstGalaxy.User.Group.lookup({ groupId: "g-1234567890" }));

      // Groups come from SCIM: when the account has one, both keys find it.
      const first = yield* galaxy.group.listGroups.items({}).pipe(Stream.runHead);
      if (first._tag === "Some") {
        const expected = { groupId: first.value.groupId, name: first.value.groupName };
        yield* expectFound(
          StarburstGalaxy.User.Group.lookup({ name: first.value.groupName }),
          expected,
        );
        yield* expectFound(
          StarburstGalaxy.User.Group.lookup({ groupId: first.value.groupId }),
          expected,
        );
      }

      const declared = yield* stack
        .deploy(StarburstGalaxy.User.Group("Analysts", { name: "analysts" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(declared)).toBe(true);
      expect(String(Exit.isFailure(declared) && declared.cause)).toContain("can only be looked up");

      yield* stack.destroy();
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:group", "live"],
    timeout: 300_000,
  },
);
