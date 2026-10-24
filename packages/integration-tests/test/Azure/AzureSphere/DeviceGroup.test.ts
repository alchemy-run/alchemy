import * as Azure from "@alchemy.run/azure";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { catalogProgram, getDeviceGroup, gone, logLevel, tags } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (
  props: Omit<Azure.AzureSphere.DeviceGroupProps, "resourceGroup" | "catalog" | "product">,
) =>
  Effect.gen(function* () {
    const { group, catalog } = yield* catalogProgram;
    const product = yield* Azure.AzureSphere.Product("Product", {
      resourceGroup: group.resourceGroupName,
      catalog: catalog.catalogName,
    });
    const deviceGroup = yield* Azure.AzureSphere.DeviceGroup("DeviceGroup", {
      resourceGroup: group.resourceGroupName,
      catalog: catalog.catalogName,
      product: product.productName,
      ...props,
    });
    return { group, catalog, product, deviceGroup };
  });

// Azure Sphere catalogs, products, and device groups are free; about 2 minutes.
test.provider(
  "create, update, replace, and delete an azure sphere device group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, catalog, product, deviceGroup } = yield* stack.deploy(
        program({ description: "v1" }),
      );
      const rg = group.resourceGroupName;
      const cat = catalog.catalogName;
      const prod = product.productName;
      expect(deviceGroup.deviceGroupName).toMatch(/^[A-Za-z0-9]{3,50}$/);
      expect(deviceGroup.description).toEqual("v1");
      expect(deviceGroup.osFeedType).toEqual("Retail");
      expect(deviceGroup.updatePolicy).toEqual("UpdateAll");
      expect(deviceGroup.allowCrashDumpsCollection).toEqual(false);
      expect(deviceGroup.regionalDataBoundary).toEqual("None");
      const observed = yield* getDeviceGroup(rg, cat, prod, deviceGroup.deviceGroupName);
      expect(observed.properties?.description).toMatch(/^v1 \[alchemy [0-9a-f]{12}\]$/);
      expect(observed.properties?.osFeedType).toEqual("Retail");

      // In place: description, OS feed, update policy, crash dumps, data boundary.
      const updated = yield* stack.deploy(
        program({
          description: "v2",
          osFeedType: "RetailEval",
          updatePolicy: "No3rdPartyAppUpdates",
          allowCrashDumpsCollection: true,
          regionalDataBoundary: "EU",
        }),
      );
      expect(updated.deviceGroup.deviceGroupName).toEqual(deviceGroup.deviceGroupName);
      expect(updated.deviceGroup.osFeedType).toEqual("RetailEval");
      expect(updated.deviceGroup.allowCrashDumpsCollection).toEqual(true);
      const reobserved = yield* getDeviceGroup(rg, cat, prod, deviceGroup.deviceGroupName);
      expect(reobserved.properties?.description).toMatch(/^v2 \[alchemy /);
      expect(reobserved.properties?.osFeedType).toEqual("RetailEval");
      expect(reobserved.properties?.updatePolicy).toEqual("No3rdPartyAppUpdates");
      expect(reobserved.properties?.regionalDataBoundary).toEqual("EU");
      expect(reobserved.properties?.allowCrashDumpsCollection).toEqual("Enabled");

      // Replacement: the name is the device group's identity.
      const replaced = yield* stack.deploy(
        program({ name: "AlchemySphereGroup", description: "v2" }),
      );
      expect(replaced.deviceGroup.deviceGroupName).toEqual("AlchemySphereGroup");
      const renamed = yield* getDeviceGroup(rg, cat, prod, "AlchemySphereGroup");
      expect(renamed.properties?.osFeedType).toEqual("Retail");
      expect(renamed.properties?.regionalDataBoundary).toEqual("None");
      expect(yield* gone(getDeviceGroup(rg, cat, prod, deviceGroup.deviceGroupName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* gone(getDeviceGroup(rg, cat, prod, "AlchemySphereGroup"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
