import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cs from "@distilled.cloud/azure/containerservice";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getFleet = (resourceGroupName: string, fleetName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* cs.GetFleet({ subscriptionId, resourceGroupName, fleetName });
  });

const fleetGone = (resourceGroupName: string, fleetName: string) =>
  getFleet(resourceGroupName, fleetName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const fleet = yield* Azure.ContainerService.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, fleet };
  });

// Hubless fleets are free and provision in under a minute.
test.provider(
  "create, update, replace, and delete a hubless fleet",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ tags: { env: "test" } }));
      const { group, fleet } = created;
      expect(fleet.hasHub).toEqual(false);
      expect(fleet.fleetId).toContain("/fleets/");
      const observed = yield* getFleet(
        group.resourceGroupName,
        fleet.fleetName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Fleet");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.fleet.fleetName).toEqual(fleet.fleetName);
      expect(updated.fleet.tags).toEqual({ env: "prod" });
      const reobserved = yield* getFleet(
        group.resourceGroupName,
        fleet.fleetName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      const replaced = yield* stack.deploy(
        program({
          name: `${fleet.fleetName.slice(0, 40)}-r`,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.fleet.fleetName).not.toEqual(fleet.fleetName);
      expect(
        yield* fleetGone(group.resourceGroupName, fleet.fleetName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* fleetGone(group.resourceGroupName, replaced.fleet.fleetName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:containerservice", "live"],
    timeout: 600_000,
  },
);
