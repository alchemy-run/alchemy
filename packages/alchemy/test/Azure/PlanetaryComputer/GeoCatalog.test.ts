import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as orbitalplanetarycomputer from "@distilled.cloud/azure/orbitalplanetarycomputer";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCatalog = (resourceGroupName: string, catalogName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orbitalplanetarycomputer.GetGeoCatalog({
      subscriptionId,
      resourceGroupName,
      catalogName,
    });
  });

const catalogGone = (resourceGroupName: string, catalogName: string) =>
  getCatalog(resourceGroupName, catalogName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: {
  name?: string;
  identity?: Azure.PlanetaryComputer.GeoCatalogIdentity;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const catalog = yield* Azure.PlanetaryComputer.GeoCatalog("Catalog", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      name: props.name,
      identity: props.identity,
      tags: props.tags,
    });
    return { group, catalog };
  });

// Billing is usage based (storage, data operations, ingestion vCPU-hours),
// so an empty catalog costs ~$0, but the lifecycle is slow: a DELETE runs
// in the background for ~40 minutes (GET keeps reporting `Succeeded`), and
// this test deletes twice (replacement + destroy). Expect ~60-90 minutes.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete a GeoCatalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, catalog } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(catalog.provisioningState).toEqual("Succeeded");
      expect(catalog.tier).toEqual("Basic");
      expect(catalog.catalogUri).toContain("geocatalog");
      expect(catalog.principalId).toBeUndefined();
      const observed = yield* getCatalog(
        group.resourceGroupName,
        catalog.catalogName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Catalog");

      // In place: system-assigned identity and tags.
      const updated = yield* stack.deploy(
        program({ identity: { type: "SystemAssigned" }, tags: { env: "prod" } }),
      );
      expect(updated.catalog.catalogId).toEqual(catalog.catalogId);
      expect(updated.catalog.principalId).toBeDefined();
      const reobserved = yield* getCatalog(
        group.resourceGroupName,
        catalog.catalogName,
      );
      expect(reobserved.identity?.type).toEqual("SystemAssigned");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name creates a new catalog and deletes the old.
      const replacementName = `${catalog.catalogName.slice(0, 21)}-r`;
      const replaced = yield* stack.deploy(
        program({ name: replacementName, tags: { env: "prod" } }),
      );
      expect(replaced.catalog.catalogName).toEqual(replacementName);
      expect(replaced.catalog.catalogId).not.toEqual(catalog.catalogId);
      expect(
        yield* catalogGone(group.resourceGroupName, catalog.catalogName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* catalogGone(group.resourceGroupName, replacementName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:planetarycomputer", "live"],
    timeout: 5_400_000,
  },
);
