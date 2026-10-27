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

const app = (repository: string) =>
  Effect.gen(function* () {
    const org = yield* Entire.Org("Org", {});
    const ci = yield* Entire.ServiceAccount("Ci", { orgId: org.id });
    const binding = yield* Entire.OidcBinding("GitHub", {
      accountId: ci.accountId,
      provider: "github-actions",
      attributeFilter: { repository },
    });
    return { ci, binding };
  });

test.provider(
  "create, replace on filter change, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(app("alchemy-run/alchemy"));
      expect(first.binding.providerId).toMatch(/^wip_/);
      const listed = yield* EntireSdk.serviceAccounts.listBindings({
        accountId: first.ci.accountId,
      });
      expect(listed.bindings.map((b) => b.id)).toContain(first.binding.id);

      const second = yield* stack.deploy(app("alchemy-run/distilled"));
      expect(second.binding.id).not.toEqual(first.binding.id);
      expect(second.binding.attributeFilter).toEqual({ repository: "alchemy-run/distilled" });
      const after = yield* EntireSdk.serviceAccounts.listBindings({
        accountId: first.ci.accountId,
      });
      expect(after.bindings.map((b) => b.id)).toEqual([second.binding.id]);

      yield* stack.destroy();
    }),
  opts,
);
