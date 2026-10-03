import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  nfvis: Azure.HybridNetwork.SiteNfvi[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const site = yield* Azure.HybridNetwork.Site("Site", {
      resourceGroup: group.resourceGroupName,
      location,
      name: props.name,
      nfvis: props.nfvis,
      tags: props.tags,
    });
    return { group, site };
  });

const east = {
  name: "east",
  nfviType: "AzureCore",
  location: "eastus",
} as const;
const west = {
  name: "west",
  nfviType: "AzureCore",
  location: "westus3",
} as const;

// Sites are free metadata resources (~1 minute).
test.provider(
  "create, update, replace, and delete a site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        program({ nfvis: [east], tags: { env: "one" } }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetSite({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            siteName: name,
          });
        });
      expect(site.nfvis).toEqual([east]);
      const observed = yield* get(site.siteName);
      expect(observed.properties?.nfvis).toEqual([east]);
      expect(observed.tags?.env).toEqual("one");

      // In-place: NFVIs and tags.
      const updated = yield* stack.deploy(
        program({ nfvis: [east, west], tags: { env: "two" } }),
      );
      expect(updated.site.siteId).toEqual(site.siteId);
      const reobserved = yield* get(site.siteName);
      expect(reobserved.properties?.nfvis).toEqual([east, west]);
      expect(reobserved.tags?.env).toEqual("two");

      // Replacement: the name is immutable.
      const renamed = `${site.siteName.slice(0, 50)}-r`;
      const replaced = yield* stack.deploy(
        program({ name: renamed, nfvis: [east], tags: { env: "two" } }),
      );
      expect(replaced.site.siteName).toEqual(renamed);
      expect((yield* get(renamed)).properties?.nfvis).toEqual([east]);
      expect(yield* waitGone(get(site.siteName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(renamed))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
