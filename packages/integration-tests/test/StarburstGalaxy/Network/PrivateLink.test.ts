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
  "PrivateLink connections are looked up by name or ID; declaring one is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const provider = yield* Provider.findProvider(StarburstGalaxy.PrivateLink);

      expect(yield* provider.lookup!({ name: "alchemy-no-such-link" })).toBeUndefined();
      expect(yield* provider.lookup!({ privateLinkId: "pvtlnk-1234567890" })).toBeUndefined();

      // Starburst provisions connections through support: when the account has one, both keys find it.
      const first = yield* galaxy.privatelink.listPrivateLinks.items({}).pipe(Stream.runHead);
      if (first._tag === "Some") {
        const byName = yield* provider.lookup!({ name: first.value.name });
        expect(byName?.privateLinkId).toBe(first.value.privatelinkId);
        const byId = yield* provider.lookup!({ privateLinkId: first.value.privatelinkId });
        expect(byId?.cloudRegionId).toBe(first.value.cloudRegionId);
      }

      const declared = yield* stack
        .deploy(StarburstGalaxy.PrivateLink("Link", { name: "rds" }))
        .pipe(Effect.exit);
      expect(Exit.isFailure(declared)).toBe(true);
      expect(String(Exit.isFailure(declared) && declared.cause)).toContain("can only be looked up");

      yield* stack.destroy();
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:privatelink", "live"],
    timeout: 60_000,
  },
);
