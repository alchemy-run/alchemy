import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  allowMultipleSites: boolean;
  grouped: boolean;
  tags?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const vmware = yield* Azure.Migrate.VmwareSite("Vmware", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
    });
    const master = yield* Azure.Migrate.MasterSite("Master", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
      allowMultipleSites: props.allowMultipleSites,
      sites: props.grouped ? [vmware.siteId] : [],
    });
    return { group, vmware, master };
  });

const getSite = (resourceGroupName: string, siteName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetMasterSitesController({
      subscriptionId: yield* subscription,
      resourceGroupName,
      siteName,
    });
  });

// Free control-plane objects; under a minute.
test.provider(
  "create, update, replace, and delete a master site",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, master } = yield* stack.deploy(
        program({ location, allowMultipleSites: true, grouped: false, tags: { env: "test" } }),
      );
      const get = (name: string) => getSite(group.resourceGroupName, name);
      expect(master.location).toEqual(location);
      expect(master.siteId.toLowerCase()).toContain(
        `/providers/microsoft.offazure/mastersites/${master.siteName.toLowerCase()}`,
      );
      expect(master.allowMultipleSites).toEqual(true);
      expect(master.sites).toEqual([]);
      const observed = yield* get(master.siteName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Master");
      expect(observed.properties?.allowMultipleSites).toEqual(true);

      // In place: tags and the grouped fabric sites.
      const updated = yield* stack.deploy(
        program({ location, allowMultipleSites: true, grouped: true, tags: { env: "prod" } }),
      );
      expect(updated.master.siteId).toEqual(master.siteId);
      expect(updated.master.tags).toEqual({ env: "prod" });
      const reobserved = yield* get(master.siteName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.sites?.map((id) => id.toLowerCase())).toEqual([
        updated.vmware.siteId.toLowerCase(),
      ]);

      // Replacement: Azure honors `allowMultipleSites` only on create.
      const single = yield* stack.deploy(
        program({ location, allowMultipleSites: false, grouped: false, tags: { env: "prod" } }),
      );
      expect(single.master.siteName).not.toEqual(master.siteName);
      const singleObserved = yield* get(single.master.siteName);
      expect(singleObserved.properties?.allowMultipleSites).toEqual(false);
      expect(yield* waitGone(get(master.siteName))).toEqual("gone");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          allowMultipleSites: false,
          grouped: false,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.master.location).toEqual("westus2");
      expect(replaced.master.siteName).not.toEqual(single.master.siteName);
      expect(yield* waitGone(get(single.master.siteName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.master.siteName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
