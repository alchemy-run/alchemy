import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCatalog = (
  resourceGroupName: string,
  devCenterName: string,
  catalogName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetCatalog({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
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
    });
    const catalog = yield* Azure.DevCenter.Catalog("Catalog", {
      resourceGroup: group.resourceGroupName,
      devCenter: center.devCenterName,
      name: props.name,
      gitHub: {
        uri: "https://github.com/microsoft/devcenter-catalog.git",
        branch: "main",
        path: "/Environment-Definitions",
      },
      syncType: props.syncType,
      tags: props.tags,
    });
    return { group, center, catalog };
  });

// Dev centers and catalogs are free; ~3-5 minutes in total.
test.provider(
  "create, update, replace, and delete a dev center catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, catalog } = yield* stack.deploy(
        program({ syncType: "Manual", tags: { a: "1" } }),
      );
      expect(catalog.sourceType).toEqual("gitHub");
      const observed = yield* getCatalog(
        group.resourceGroupName,
        center.devCenterName,
        catalog.catalogName,
      );
      expect(observed.properties?.gitHub?.uri).toEqual(
        "https://github.com/microsoft/devcenter-catalog.git",
      );
      expect(observed.properties?.syncType).toEqual("Manual");
      expect(observed.properties?.tags?.a).toEqual("1");
      expect(observed.properties?.tags?.["alchemy::id"]).toEqual("Catalog");

      // In place: sync type and tags.
      const updated = yield* stack.deploy(
        program({ syncType: "Scheduled", tags: { a: "2" } }),
      );
      expect(updated.catalog.catalogId).toEqual(catalog.catalogId);
      const reobserved = yield* getCatalog(
        group.resourceGroupName,
        center.devCenterName,
        catalog.catalogName,
      );
      expect(reobserved.properties?.syncType).toEqual("Scheduled");
      expect(reobserved.properties?.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-catalog-renamed",
          syncType: "Scheduled",
          tags: { a: "2" },
        }),
      );
      expect(replaced.catalog.catalogName).toEqual("alchemy-catalog-renamed");
      expect(
        yield* waitGone(
          getCatalog(
            group.resourceGroupName,
            center.devCenterName,
            catalog.catalogName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCatalog(
            group.resourceGroupName,
            center.devCenterName,
            replaced.catalog.catalogName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
