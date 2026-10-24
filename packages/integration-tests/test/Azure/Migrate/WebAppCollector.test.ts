import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  rotatedServicePrincipal,
  servicePrincipal,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: { site: "A" | "B"; principal: "first" | "second" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const project = yield* Azure.Migrate.AssessmentProject("Project", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const sites = {
      A: yield* Azure.Migrate.VmwareSite("SiteA", {
        resourceGroup: group.resourceGroupName,
        location,
      }),
      B: yield* Azure.Migrate.VmwareSite("SiteB", {
        resourceGroup: group.resourceGroupName,
        location,
      }),
    };
    const site = sites[props.site];
    const collector = yield* Azure.Migrate.WebAppCollector("Collector", {
      resourceGroup: group.resourceGroupName,
      assessmentProject: project.projectName,
      agentId: site.agentId,
      discoverySiteId: site.siteId,
      servicePrincipal: props.principal === "first" ? servicePrincipal : rotatedServicePrincipal,
    });
    return { group, project, sites, collector };
  });

const getCollector = (resourceGroupName: string, projectName: string, name: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetWebAppCollectorOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      collectorName: name,
    });
  });

// Free control-plane objects; about a minute.
test.provider(
  "create, redeploy, replace, and delete a web-app collector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, sites, collector } = yield* stack.deploy(
        program({ site: "A", principal: "first" }),
      );
      const get = (name: string) =>
        getCollector(group.resourceGroupName, project.projectName, name);
      expect(sites.A.agentId).not.toEqual("");
      expect(collector.agentId).toEqual(sites.A.agentId);
      expect(collector.discoverySiteId?.toLowerCase()).toEqual(sites.A.siteId.toLowerCase());
      const observed = yield* get(collector.collectorName);
      expect(observed.properties?.agentProperties?.id).toEqual(sites.A.agentId);
      expect(observed.properties?.agentProperties?.spnDetails?.applicationId).toEqual(
        servicePrincipal.applicationId,
      );

      // Redeploying the same props keeps the collector.
      const same = yield* stack.deploy(program({ site: "A", principal: "first" }));
      expect(same.collector.collectorId).toEqual(collector.collectorId);

      // Replacement: Azure fixes the agent's service principal.
      const rotated = yield* stack.deploy(program({ site: "A", principal: "second" }));
      expect(rotated.collector.collectorName).not.toEqual(collector.collectorName);
      const rotatedObserved = yield* get(rotated.collector.collectorName);
      expect(rotatedObserved.properties?.agentProperties?.spnDetails?.applicationId).toEqual(
        rotatedServicePrincipal.applicationId,
      );
      expect(yield* waitGone(get(collector.collectorName))).toEqual("gone");

      // Replacement: the agent and discovery site are immutable.
      const replaced = yield* stack.deploy(program({ site: "B", principal: "second" }));
      expect(replaced.collector.collectorName).not.toEqual(rotated.collector.collectorName);
      expect(replaced.collector.agentId).toEqual(replaced.sites.B.agentId);
      expect(yield* waitGone(get(rotated.collector.collectorName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.collector.collectorName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
