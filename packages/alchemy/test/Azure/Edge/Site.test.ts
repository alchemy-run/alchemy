import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getSite = (resourceGroupName: string, siteName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetSite({
      subscriptionId: yield* subscription,
      resourceGroupName,
      siteName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  labels: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const site = yield* Azure.Edge.Site("Site", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      displayName: "Alchemy test site",
      description: props.description,
      siteAddress: { city: "Seattle", country: "US" },
      labels: props.labels,
    });
    return { group, site };
  });

// Free control-plane resource; provisions in seconds.
test.provider(
  "create, update, replace, and delete a site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        program({ description: "first", labels: { env: "test", tier: "a" } }),
      );
      const rg = group.resourceGroupName;
      expect(site.siteId).toContain("/providers/Microsoft.Edge/sites/");
      expect(site.labels).toEqual({ env: "test", tier: "a" });
      const observed = yield* getSite(rg, site.siteName);
      expect(observed.properties?.description).toEqual("first");
      expect(observed.properties?.siteAddress?.city).toEqual("Seattle");
      expect(observed.properties?.labels?.["alchemy::id"]).toEqual("Site");

      // In-place: description changes and a label is removed.
      const updated = yield* stack.deploy(
        program({ description: "second", labels: { env: "prod" } }),
      );
      expect(updated.site.siteId).toEqual(site.siteId);
      const reobserved = yield* getSite(rg, site.siteName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.properties?.labels?.env).toEqual("prod");
      expect(reobserved.properties?.labels?.tier).toBeUndefined();

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-site-renamed",
          description: "second",
          labels: { env: "prod" },
        }),
      );
      expect(replaced.site.siteName).toEqual("alchemy-site-renamed");
      expect(
        (yield* getSite(rg, "alchemy-site-renamed")).properties?.description,
      ).toEqual("second");
      expect(yield* waitGone(getSite(rg, site.siteName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(getSite(rg, "alchemy-site-renamed"))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
