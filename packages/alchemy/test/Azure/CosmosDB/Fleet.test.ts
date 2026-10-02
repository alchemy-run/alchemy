import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, waitGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "eastus";

const getFleet = (resourceGroupName: string, fleetName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetFleet({ subscriptionId, resourceGroupName, fleetName }),
  );

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const fleet = yield* Azure.CosmosDB.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      name: props.name,
      tags: props.tags,
    });
    return { group, fleet };
  });

// A fleet is free and provisions in seconds.
test.provider(
  "create, update, replace, and delete a Cosmos DB fleet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fleet } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(fleet.location).toEqual(LOCATION);
      expect(fleet.tags).toEqual({ env: "test" });
      const observed = yield* getFleet(group.resourceGroupName, fleet.fleetName);
      expect(observed.id).toEqual(fleet.fleetId);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Fleet");

      // In-place update: tags.
      const updated = yield* stack.deploy(
        program({ tags: { env: "prod", team: "data" } }),
      );
      expect(updated.fleet.fleetName).toEqual(fleet.fleetName);
      const retagged = yield* getFleet(
        group.resourceGroupName,
        fleet.fleetName,
      );
      expect(retagged.tags?.env).toEqual("prod");
      expect(retagged.tags?.team).toEqual("data");

      // Replacement: a new name creates a new fleet and deletes the old.
      const renamedName = `${fleet.fleetName.slice(0, 36)}-renamed`;
      const replaced = yield* stack.deploy(
        program({ name: renamedName, tags: { env: "prod" } }),
      );
      expect(replaced.fleet.fleetName).toEqual(renamedName);
      const renamed = yield* getFleet(group.resourceGroupName, renamedName);
      expect(renamed.name).toEqual(renamedName);
      expect(
        yield* waitGone(getFleet(group.resourceGroupName, fleet.fleetName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getFleet(group.resourceGroupName, renamedName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 600_000,
  },
);
