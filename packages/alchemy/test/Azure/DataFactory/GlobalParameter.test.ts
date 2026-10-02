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

const getGlobalParameter = (
  resourceGroupName: string,
  factoryName: string,
  globalParameterName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetGlobalParameter({
      subscriptionId,
      resourceGroupName,
      factoryName,
      globalParameterName,
    });
  });

const globalParameterGone = (
  resourceGroupName: string,
  factoryName: string,
  globalParameterName: string,
) =>
  getGlobalParameter(resourceGroupName, factoryName, globalParameterName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (
  parameters: Azure.DataFactory.GlobalParameterProps["parameters"],
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("GlobalParameterGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("GlobalParameterFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const params = yield* Azure.DataFactory.GlobalParameter("Params", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      parameters,
    });
    return { group, factory, params };
  });

// ~$0: global parameters are free. ~1 minute.
test.provider(
  "create, update, and delete global parameters",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, params } = yield* stack.deploy(
        program({ env: { type: "String", value: "test" } }),
      );
      expect(params.globalParameterName).toEqual("default");
      const observed = yield* getGlobalParameter(
        group.resourceGroupName,
        factory.factoryName,
        params.globalParameterName,
      );
      expect(observed.properties).toEqual({
        env: { type: "String", value: "test" },
      });

      // Add an Int parameter.
      yield* stack.deploy(
        program({
          env: { type: "String", value: "test" },
          batchSize: { type: "Int", value: 500 },
        }),
      );
      const added = yield* getGlobalParameter(
        group.resourceGroupName,
        factory.factoryName,
        params.globalParameterName,
      );
      expect(added.properties).toEqual({
        env: { type: "String", value: "test" },
        batchSize: { type: "Int", value: 500 },
      });

      // Remove one, change the other.
      const updated = yield* stack.deploy(
        program({ batchSize: { type: "Int", value: 1000 } }),
      );
      expect(updated.params.parameters).toEqual({
        batchSize: { type: "Int", value: 1000 },
      });
      const removed = yield* getGlobalParameter(
        group.resourceGroupName,
        factory.factoryName,
        params.globalParameterName,
      );
      expect(removed.properties).toEqual({
        batchSize: { type: "Int", value: 1000 },
      });

      yield* stack.destroy();
      expect(
        yield* globalParameterGone(
          group.resourceGroupName,
          factory.factoryName,
          params.globalParameterName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
