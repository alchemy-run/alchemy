import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSite = (siteName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetSitesBySubscription({
      subscriptionId: yield* subscription,
      siteName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  labels: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const site = yield* Azure.Edge.SubscriptionSite("Site", {
      name: props.name,
      displayName: "Alchemy subscription site",
      description: props.description,
      labels: props.labels,
    });
    return { site };
  });

// Free control-plane resource; provisions in seconds. Azure allows one
// subscription-scope site, so this suite owns that slot while it runs.
test.provider(
  "create, update, replace, and delete a subscription site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { site } = yield* stack.deploy(
        program({ description: "first", labels: { env: "test", tier: "a" } }),
      );
      expect(site.siteId).not.toMatch(/resourceGroups/i);
      const observed = yield* getSite(site.siteName);
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.labels?.["alchemy::id"]).toEqual("Site");

      // In-place: description changes and a label is removed.
      const updated = yield* stack.deploy(
        program({ description: "second", labels: { env: "prod" } }),
      );
      expect(updated.site.siteId).toEqual(site.siteId);
      const reobserved = yield* getSite(site.siteName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.properties?.labels?.env).toEqual("prod");
      expect(reobserved.properties?.labels?.tier).toBeUndefined();

      // Replacement: a new name (delete-first, one site per scope).
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-subsite-renamed",
          description: "second",
          labels: { env: "prod" },
        }),
      );
      expect(replaced.site.siteName).toEqual("alchemy-subsite-renamed");
      expect(
        (yield* getSite("alchemy-subsite-renamed")).properties?.description,
      ).toEqual("second");
      expect(yield* waitGone(getSite(site.siteName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getSite("alchemy-subsite-renamed"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
