import * as Entire from "@alchemy.run/entire";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as EntireSdk from "@distilled.cloud/entire";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Entire.providers() });

// Entire caps an account's projects and org creations, and a burst of
// parallel creates leaves projects whose owner grant never lands, so the
// Entire suites take turns.
const opts = { tags: ["provider:entire", "live"], timeout: 180_000, exclusive: "entire:account" };

test.provider(
  "create, replace on rename, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const org = yield* stack.deploy(Entire.Org("Org", {}));
      const observed = yield* EntireSdk.orgs.getOrg({ orgId: org.id });
      expect(observed.name).toEqual(org.name);

      const renamed = yield* stack.deploy(Entire.Org("Org", { name: `${org.name}-renamed` }));
      expect(renamed.id).not.toEqual(org.id);
      const oldGone = yield* EntireSdk.orgs.getOrg({ orgId: org.id }).pipe(Effect.flip);
      expect(oldGone._tag).toEqual("NotFound");

      yield* stack.destroy();
      const gone = yield* EntireSdk.orgs.getOrg({ orgId: renamed.id }).pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }),
  opts,
);
