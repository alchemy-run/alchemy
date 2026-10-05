import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getFactory = (resourceGroupName: string, factoryName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetFactory({
      subscriptionId,
      resourceGroupName,
      factoryName,
    });
  });

const factoryGone = (resourceGroupName: string, factoryName: string) =>
  getFactory(resourceGroupName, factoryName).pipe(
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

const program = (props: {
  location: string;
  publicNetworkAccess: "Enabled" | "Disabled";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("FactoryGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("Etl", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      identity: { type: "SystemAssigned" },
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, factory };
  });

// ~$0: an empty factory is free. ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a data factory",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory } = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      expect(factory.factoryName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(factory.provisioningState).toEqual("Succeeded");
      expect(factory.principalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(factory.tags).toEqual({ env: "test" });
      const observed = yield* getFactory(
        group.resourceGroupName,
        factory.factoryName,
      );
      expect(observed.identity?.type).toEqual("SystemAssigned");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Etl");
      expect(observed.properties?.publicNetworkAccess ?? "Enabled").toEqual(
        "Enabled",
      );

      // In place: public network access and tags.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.factory.factoryName).toEqual(factory.factoryName);
      expect(updated.factory.principalId).toEqual(factory.principalId);
      const reobserved = yield* getFactory(
        group.resourceGroupName,
        factory.factoryName,
      );
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(reobserved.tags?.env).toEqual("prod");

      // Location change replaces the factory.
      const replaced = yield* stack.deploy(
        program({
          location: "eastus2",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.factory.factoryName).not.toEqual(factory.factoryName);
      expect(replaced.factory.location).toEqual("eastus2");
      expect(
        yield* factoryGone(group.resourceGroupName, factory.factoryName),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* factoryGone(
          group.resourceGroupName,
          replaced.factory.factoryName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
