import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  applianceName?: string;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const site = yield* Azure.Migrate.HypervSite("Site", {
      resourceGroup: group.resourceGroupName,
      ...props,
    });
    return { group, site };
  });

const getSite = (resourceGroupName: string, siteName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetHypervSitesController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      siteName,
    });
  });

// Free control-plane object; under a minute.
test.provider(
  "create, update, replace, and delete a Hyper-V discovery site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, site } = yield* stack.deploy(
        program({ location, applianceName: "appliance-1", tags: { env: "test" } }),
      );
      const get = (name: string) => getSite(group.resourceGroupName, name);
      expect(site.location).toEqual(location);
      expect(site.siteId.toLowerCase()).toContain(
        `/providers/microsoft.offazure/hypervsites/${site.siteName.toLowerCase()}`,
      );
      expect(site.applianceName).toEqual("appliance-1");
      const observed = yield* get(site.siteName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Site");
      expect(observed.properties?.applianceName).toEqual("appliance-1");

      // In place: tags.
      const updated = yield* stack.deploy(
        program({ location, applianceName: "appliance-1", tags: { env: "prod", team: "migrate" } }),
      );
      expect(updated.site.siteId).toEqual(site.siteId);
      expect(updated.site.tags).toEqual({ env: "prod", team: "migrate" });
      const reobserved = yield* get(site.siteName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.tags?.team).toEqual("migrate");
      expect(reobserved.tags?.["alchemy::id"]).toEqual("Site");

      // Replacement: Azure fixes the appliance name once the site exists.
      const renamed = yield* stack.deploy(
        program({ location, applianceName: "appliance-2", tags: { env: "prod" } }),
      );
      expect(renamed.site.siteName).not.toEqual(site.siteName);
      const renamedObserved = yield* get(renamed.site.siteName);
      expect(renamedObserved.properties?.applianceName).toEqual("appliance-2");
      expect(yield* waitGone(get(site.siteName))).toEqual("gone");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", applianceName: "appliance-2", tags: { env: "prod" } }),
      );
      expect(replaced.site.location).toEqual("westus2");
      expect(replaced.site.siteName).not.toEqual(renamed.site.siteName);
      expect(yield* waitGone(get(renamed.site.siteName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.site.siteName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
