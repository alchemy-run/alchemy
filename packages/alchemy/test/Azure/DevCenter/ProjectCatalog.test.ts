import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProjectCatalog = (
  resourceGroupName: string,
  projectName: string,
  catalogName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetProjectCatalog({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      catalogName,
    });
  });

const program = (props: {
  name?: string;
  syncType: "Manual" | "Scheduled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      projectCatalogItemSyncEnableStatus: "Enabled",
    });
    const project = yield* Azure.DevCenter.Project("Project", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      devCenterId: center.devCenterId,
      catalogItemSyncTypes: ["EnvironmentDefinition"],
    });
    const catalog = yield* Azure.DevCenter.ProjectCatalog("Catalog", {
      resourceGroup: group.resourceGroupName,
      project: project.projectName,
      name: props.name,
      gitHub: {
        uri: "https://github.com/microsoft/devcenter-catalog.git",
        branch: "main",
        path: "/Environment-Definitions",
      },
      syncType: props.syncType,
      tags: props.tags,
    });
    return { group, project, catalog };
  });

// Dev centers, projects, and catalogs are free; ~4-6 minutes in total.
test.provider(
  "create, update, replace, and delete a project catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, catalog } = yield* stack.deploy(
        program({ syncType: "Manual", tags: { a: "1" } }),
      );
      expect(catalog.sourceType).toEqual("gitHub");
      const observed = yield* getProjectCatalog(
        group.resourceGroupName,
        project.projectName,
        catalog.catalogName,
      );
      expect(observed.properties?.gitHub?.path).toEqual(
        "/Environment-Definitions",
      );
      expect(observed.properties?.syncType).toEqual("Manual");
      expect(observed.properties?.tags?.a).toEqual("1");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Catalog");

      // In place: sync type and tags.
      const updated = yield* stack.deploy(
        program({ syncType: "Scheduled", tags: { a: "2" } }),
      );
      expect(updated.catalog.catalogId).toEqual(catalog.catalogId);
      const reobserved = yield* getProjectCatalog(
        group.resourceGroupName,
        project.projectName,
        catalog.catalogName,
      );
      expect(reobserved.properties?.syncType).toEqual("Scheduled");
      expect(reobserved.properties?.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-project-catalog-renamed",
          syncType: "Scheduled",
          tags: { a: "2" },
        }),
      );
      expect(replaced.catalog.catalogName).toEqual(
        "alchemy-project-catalog-renamed",
      );
      expect(
        yield* waitGone(
          getProjectCatalog(
            group.resourceGroupName,
            project.projectName,
            catalog.catalogName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProjectCatalog(
            group.resourceGroupName,
            project.projectName,
            replaced.catalog.catalogName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
