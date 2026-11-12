import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { expectFound, expectNotFound } from "../lookup.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

test.provider(
  "PrivateLink connections are looked up by name or ID; declaring one is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* expectNotFound(StarburstGalaxy.PrivateLink.lookup({ name: "alchemy-no-such-link" }));
      yield* expectNotFound(
        StarburstGalaxy.PrivateLink.lookup({ privateLinkId: "pvtlnk-1234567890" }),
      );

      // Starburst provisions connections through support: when the account has one, both keys find it.
      const first = yield* galaxy.privatelink.listPrivateLinks.items({}).pipe(Stream.runHead);
      if (first._tag === "Some") {
        const expected = {
          privateLinkId: first.value.privatelinkId,
          name: first.value.name,
          cloudRegionId: first.value.cloudRegionId,
        };
        yield* expectFound(
          StarburstGalaxy.PrivateLink.lookup({ name: first.value.name }),
          expected,
        );
        yield* expectFound(
          StarburstGalaxy.PrivateLink.lookup({ privateLinkId: first.value.privatelinkId }),
          expected,
        );
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
