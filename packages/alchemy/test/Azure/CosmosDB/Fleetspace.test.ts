import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, waitGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const LOCATION = "eastus";

const getFleetspace = (
  resourceGroupName: string,
  fleetName: string,
  fleetspaceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetFleetspace({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetspaceName,
    }),
  );

const program = (
  props: Omit<Azure.CosmosDB.FleetspaceProps, "resourceGroup" | "fleet">,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const fleet = yield* Azure.CosmosDB.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const space = yield* Azure.CosmosDB.Fleetspace("Space", {
      resourceGroup: group.resourceGroupName,
      fleet: fleet.fleetName,
      ...props,
    });
    return { group, fleet, space };
  });

// A fleetspace without a throughput pool is free and provisions in seconds.
test.provider(
  "create, replace, and delete a Cosmos DB fleetspace without pooling",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, fleet, space } = yield* stack.deploy(program({}));
      expect(space.fleet).toEqual(fleet.fleetName);
      expect(space.throughputPool).toBeUndefined();
      const observed = yield* getFleetspace(
        group.resourceGroupName,
        fleet.fleetName,
        space.fleetspaceName,
      );
      expect(observed.id).toEqual(space.fleetspaceId);
      expect(observed.properties?.fleetspaceApiKind).toEqual("NoSQL");

      // Re-deploying the same props is a no-op.
      const again = yield* stack.deploy(program({}));
      expect(again.space.fleetspaceId).toEqual(space.fleetspaceId);

      // Replacement: a new name creates a new fleetspace and deletes the old.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-renamed" }),
      );
      expect(replaced.space.fleetspaceName).toEqual("alchemy-renamed");
      const renamed = yield* getFleetspace(
        group.resourceGroupName,
        fleet.fleetName,
        "alchemy-renamed",
      );
      expect(renamed.name).toEqual("alchemy-renamed");
      expect(
        yield* waitGone(
          getFleetspace(
            group.resourceGroupName,
            fleet.fleetName,
            space.fleetspaceName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getFleetspace(
            group.resourceGroupName,
            fleet.fleetName,
            "alchemy-renamed",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 600_000,
  },
);

// A throughput pool bills its minimum (100,000 RU/s, ~$8/hour, billed per
// started hour) even when idle: ~$8-16 per run. Provisions in minutes.
test.provider.skipIf(!runExpensive)(
  "create and resize a Cosmos DB fleetspace throughput pool",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const pooled = {
        serviceTier: "GeneralPurpose" as const,
        dataRegions: [LOCATION],
      };
      const { group, fleet, space } = yield* stack.deploy(
        program({
          ...pooled,
          throughputPool: { minThroughput: 100_000, maxThroughput: 100_000 },
        }),
      );
      expect(space.throughputPool).toEqual({
        minThroughput: 100_000,
        maxThroughput: 100_000,
      });

      // In-place update: pool maximum.
      const resized = yield* stack.deploy(
        program({
          ...pooled,
          throughputPool: { minThroughput: 100_000, maxThroughput: 200_000 },
        }),
      );
      expect(resized.space.fleetspaceId).toEqual(space.fleetspaceId);
      const observed = yield* getFleetspace(
        group.resourceGroupName,
        fleet.fleetName,
        space.fleetspaceName,
      );
      expect(
        observed.properties?.throughputPoolConfiguration?.maxThroughput,
      ).toEqual(200_000);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getFleetspace(
            group.resourceGroupName,
            fleet.fleetName,
            space.fleetspaceName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 600_000,
  },
);
