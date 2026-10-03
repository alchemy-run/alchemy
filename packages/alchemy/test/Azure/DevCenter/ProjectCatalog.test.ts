import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
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

// Dev centers, projects, and catalogs are free ($0). Catalog writes are
// slow while the repository syncs (~40s create, ~40s update, ~160s delete)
// and a dev center takes ~5 minutes to delete: ~12-13 minutes in total.
test.provider(
  "create, update, and delete a project catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project: parent, catalog } = yield* stack.deploy(
        program({ syncType: "Manual", tags: { a: "1" } }),
      );
      expect(catalog.sourceType).toEqual("gitHub");
      const observed = yield* getProjectCatalog(
        group.resourceGroupName,
        parent.projectName,
        catalog.catalogName,
      );
      expect(observed.properties?.gitHub?.uri).toEqual(
        "https://github.com/microsoft/devcenter-catalog.git",
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
        parent.projectName,
        catalog.catalogName,
      );
      expect(reobserved.properties?.syncType).toEqual("Scheduled");
      expect(reobserved.properties?.tags?.a).toEqual("2");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProjectCatalog(
            group.resourceGroupName,
            parent.projectName,
            catalog.catalogName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Gated (slow, $0): the replacement creates the new catalog while the old
// one still syncs (~140s) and deletes the old one (~200s); with the dev
// center delete the whole run takes ~17 minutes.
test.provider.skipIf(!runExpensive)(
  "replace a project catalog when its name changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project: parent, catalog } = yield* stack.deploy(
        program({ syncType: "Manual", tags: { a: "1" } }),
      );
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-project-catalog-renamed",
          syncType: "Manual",
          tags: { a: "1" },
        }),
      );
      expect(replaced.catalog.catalogName).toEqual("alchemy-project-catalog-renamed");
      expect(replaced.catalog.catalogId).not.toEqual(catalog.catalogId);
      expect(
        yield* waitGone(
          getProjectCatalog(
            group.resourceGroupName,
            parent.projectName,
            catalog.catalogName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getProjectCatalog(
            group.resourceGroupName,
            parent.projectName,
            replaced.catalog.catalogName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
