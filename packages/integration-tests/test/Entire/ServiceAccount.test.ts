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

      const app = (name?: string) =>
        Effect.gen(function* () {
          const org = yield* Entire.Org("Org", {});
          return yield* Entire.ServiceAccount("Ci", { orgId: org.id, name });
        });

      const sa = yield* stack.deploy(app());
      const observed = yield* EntireSdk.serviceAccounts.getServiceAccount({
        accountId: sa.accountId,
      });
      expect(observed.name).toEqual(sa.name);
      expect(observed.orgId).toEqual(sa.orgId);

      const renamed = yield* stack.deploy(app("ci-renamed"));
      expect(renamed.accountId).not.toEqual(sa.accountId);
      expect(renamed.name).toEqual("ci-renamed");
      const oldGone = yield* EntireSdk.serviceAccounts
        .getServiceAccount({ accountId: sa.accountId })
        .pipe(Effect.flip);
      expect(oldGone._tag).toEqual("NotFound");

      yield* stack.destroy();
      const gone = yield* EntireSdk.serviceAccounts
        .getServiceAccount({ accountId: renamed.accountId })
        .pipe(Effect.flip);
      expect(gone._tag).toEqual("NotFound");
    }),
  opts,
);
