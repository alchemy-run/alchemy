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

const getCdc = (
  resourceGroupName: string,
  factoryName: string,
  changeDataCaptureName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetChangeDataCapture({
      subscriptionId,
      resourceGroupName,
      factoryName,
      changeDataCaptureName,
    });
  });

const cdcGone = (
  resourceGroupName: string,
  factoryName: string,
  changeDataCaptureName: string,
) =>
  getCdc(resourceGroupName, factoryName, changeDataCaptureName).pipe(
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

const connection = (referenceName: string) => ({
  type: "linkedservicetype",
  linkedService: { referenceName, type: "LinkedServiceReference" as const },
  linkedServiceType: "AzureBlobFS",
  isInlineDataset: true,
});

const program = (props: { name: string; description: string; interval: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("CdcGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("CdcFactory", {
      resourceGroup: group.resourceGroupName,
    });
    const lake = yield* Azure.DataFactory.LinkedService("CdcLake", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "AzureBlobFS",
      typeProperties: { url: "https://example.dfs.core.windows.net/" },
    });
    const cdc = yield* Azure.DataFactory.ChangeDataCapture("Cdc", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      name: props.name,
      description: props.description,
      sourceConnectionsInfo: [
        {
          sourceEntities: [{ name: "input/orders" }],
          connection: connection(lake.linkedServiceName),
        },
      ],
      targetConnectionsInfo: [
        {
          targetEntities: [{ name: "output/orders" }],
          connection: connection(lake.linkedServiceName),
        },
      ],
      policy: {
        mode: "Microbatch",
        recurrence: { frequency: "Minute", interval: props.interval },
      },
    });
    return { group, factory, cdc };
  });

// ~$0: a CDC definition that is never started is free. ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a change data capture",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, cdc } = yield* stack.deploy(
        program({ name: "orders_cdc", description: "orders", interval: 15 }),
      );
      expect(cdc.changeDataCaptureName).toEqual("orders_cdc");
      expect(cdc.description).toEqual("orders");
      const observed = yield* getCdc(
        group.resourceGroupName,
        factory.factoryName,
        "orders_cdc",
      );
      expect(observed.properties.description).toMatch(/^orders \[alchemy /);
      expect(observed.properties.policy.recurrence?.interval).toEqual(15);
      expect(observed.properties.sourceConnectionsInfo[0]?.sourceEntities?.[0]?.name).toEqual(
        "input/orders",
      );

      // In place: description and recurrence.
      yield* stack.deploy(
        program({ name: "orders_cdc", description: "orders v2", interval: 30 }),
      );
      const updated = yield* getCdc(
        group.resourceGroupName,
        factory.factoryName,
        "orders_cdc",
      );
      expect(updated.properties.description).toMatch(/^orders v2 \[alchemy /);
      expect(updated.properties.policy.recurrence?.interval).toEqual(30);

      // Renaming replaces the CDC.
      yield* stack.deploy(
        program({ name: "orders_cdc2", description: "orders v2", interval: 30 }),
      );
      const renamed = yield* getCdc(
        group.resourceGroupName,
        factory.factoryName,
        "orders_cdc2",
      );
      expect(renamed.name).toEqual("orders_cdc2");
      expect(
        yield* cdcGone(group.resourceGroupName, factory.factoryName, "orders_cdc"),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* cdcGone(
          group.resourceGroupName,
          factory.factoryName,
          "orders_cdc2",
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
