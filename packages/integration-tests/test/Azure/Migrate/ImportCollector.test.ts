import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (site: "A" | "B") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const project = yield* Azure.Migrate.AssessmentProject("Project", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const sites = {
      A: yield* Azure.Migrate.ImportSite("SiteA", {
        resourceGroup: group.resourceGroupName,
        location,
      }),
      B: yield* Azure.Migrate.ImportSite("SiteB", {
        resourceGroup: group.resourceGroupName,
        location,
      }),
    };
    const collector = yield* Azure.Migrate.ImportCollector("Collector", {
      resourceGroup: group.resourceGroupName,
      assessmentProject: project.projectName,
      discoverySiteId: sites[site].siteId,
    });
    return { group, project, sites, collector };
  });

const getCollector = (resourceGroupName: string, projectName: string, name: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetImportCollectorsOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      importCollectorName: name,
    });
  });

// Free control-plane objects; under a minute. An import collector has no
// mutable settings, so the lifecycle is create, a no-op redeploy, and
// replacement.
test.provider(
  "create, redeploy, replace, and delete an import collector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, sites, collector } = yield* stack.deploy(program("A"));
      const get = (name: string) =>
        getCollector(group.resourceGroupName, project.projectName, name);
      expect(collector.discoverySiteId?.toLowerCase()).toEqual(sites.A.siteId.toLowerCase());
      expect(collector.collectorId.toLowerCase()).toContain(
        `/assessmentprojects/${project.projectName.toLowerCase()}/importcollectors/${collector.collectorName.toLowerCase()}`,
      );
      const observed = yield* get(collector.collectorName);
      expect(observed.properties?.discoverySiteId?.toLowerCase()).toEqual(
        sites.A.siteId.toLowerCase(),
      );

      // Redeploying the same props keeps the collector.
      const same = yield* stack.deploy(program("A"));
      expect(same.collector.collectorId).toEqual(collector.collectorId);

      // Replacement: the discovery site is immutable.
      const replaced = yield* stack.deploy(program("B"));
      expect(replaced.collector.collectorName).not.toEqual(collector.collectorName);
      const moved = yield* get(replaced.collector.collectorName);
      expect(moved.properties?.discoverySiteId?.toLowerCase()).toEqual(
        replaced.sites.B.siteId.toLowerCase(),
      );
      expect(yield* waitGone(get(collector.collectorName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.collector.collectorName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
