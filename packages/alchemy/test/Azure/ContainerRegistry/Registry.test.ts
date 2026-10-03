import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { getRegistry, logLevel, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  location: string;
  sku: Azure.ContainerRegistry.RegistrySku;
  adminUserEnabled: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const registry = yield* Azure.ContainerRegistry.Registry("Registry", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: props.sku,
      adminUserEnabled: props.adminUserEnabled,
      tags: props.tags,
    });
    return { group, registry };
  });

// Basic (~$0.17/day) then Standard (~$0.67/day), billed per day: < $1 per
// run, each registry provisions in under a minute.
test.provider(
  "create, update, replace, and delete a container registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry } = yield* stack.deploy(
        program({
          location: "eastus",
          sku: "Basic",
          adminUserEnabled: false,
          tags: { env: "test" },
        }),
      );
      expect(registry.registryName).toMatch(/^[a-z0-9]{5,50}$/);
      expect(registry.loginServer).toEqual(
        `${registry.registryName}.azurecr.io`,
      );
      expect(registry.adminUsername).toBeUndefined();
      const observed = yield* getRegistry(
        group.resourceGroupName,
        registry.registryName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku.name).toEqual("Basic");
      expect(observed.properties?.adminUserEnabled).toEqual(false);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Registry");

      // In-place: enable the admin user, retag, upgrade to Standard.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          sku: "Standard",
          adminUserEnabled: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.registry.registryId).toEqual(registry.registryId);
      expect(updated.registry.adminUsername).toBeDefined();
      expect(
        Redacted.value(updated.registry.adminPassword!).length,
      ).toBeGreaterThan(0);
      const reobserved = yield* getRegistry(
        group.resourceGroupName,
        registry.registryName,
      );
      expect(reobserved.sku.name).toEqual("Standard");
      expect(reobserved.properties?.adminUserEnabled).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          sku: "Basic",
          adminUserEnabled: false,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.registry.registryName).not.toEqual(registry.registryName);
      const replacedObserved = yield* getRegistry(
        group.resourceGroupName,
        replaced.registry.registryName,
      );
      expect(replacedObserved.location).toEqual("westus2");
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, registry.registryName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getRegistry(group.resourceGroupName, replaced.registry.registryName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
