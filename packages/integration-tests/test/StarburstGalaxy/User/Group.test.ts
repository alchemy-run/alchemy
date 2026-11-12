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
  "groups are looked up by name or ID; declaring a group is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.findProvider(StarburstGalaxy.Group);

      expect(yield* provider.lookup!({ name: "alchemy-no-such-group" })).toBeUndefined();
      expect(yield* provider.lookup!({ groupId: "g-0000000000" })).toBeUndefined();

      // Groups come from SCIM: when the account has one, both keys find it.
      const first = yield* galaxy.group.listGroups.items({}).pipe(Stream.runHead);
      if (first._tag === "Some") {
        const byName = yield* provider.lookup!({ name: first.value.groupName });
        expect(byName?.groupId).toBe(first.value.groupId);
        const byId = yield* provider.lookup!({ groupId: first.value.groupId });
        expect(byId?.name).toBe(first.value.groupName);
      }

      const declared = yield* stack
        .deploy(StarburstGalaxy.Group("Analysts", { name: "analysts" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(declared)).toBe(true);
      expect(String(Exit.isFailure(declared) && declared.cause)).toContain("can only be looked up");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:group", "live"],
    timeout: 60_000,
  },
);
