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

const getDataFlow = (
  resourceGroupName: string,
  factoryName: string,
  dataFlowName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetDataFlow({
      subscriptionId,
      resourceGroupName,
      factoryName,
      dataFlowName,
    });
  });

const dataFlowGone = (
  resourceGroupName: string,
  factoryName: string,
  dataFlowName: string,
) =>
  getDataFlow(resourceGroupName, factoryName, dataFlowName).pipe(
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

const program = (props: { scriptLines: string[] }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("DataFlowGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("DataFlowFactory", {
      resourceGroup: group.resourceGroupName,
      identity: { type: "SystemAssigned" },
    });
    const blob = yield* Azure.DataFactory.LinkedService("FlowBlob", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "AzureBlobStorage",
      typeProperties: {
        serviceEndpoint: "https://alchemydataflowtest.blob.core.windows.net/",
        accountKind: "StorageV2",
      },
    });
    const dataset = (id: string, folderPath: string) =>
      Azure.DataFactory.Dataset(id, {
        resourceGroup: group.resourceGroupName,
        factoryName: factory.factoryName,
        type: "DelimitedText",
        linkedServiceName: { referenceName: blob.linkedServiceName },
        typeProperties: {
          location: {
            type: "AzureBlobStorageLocation",
            container: "data",
            folderPath,
          },
          columnDelimiter: ",",
          firstRowAsHeader: true,
        },
      });
    const raw = yield* dataset("RawOrders", "raw");
    const curated = yield* dataset("CuratedOrders", "curated");
    const flow = yield* Azure.DataFactory.DataFlow("Orders", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      typeProperties: {
        sources: [
          {
            name: "input",
            dataset: {
              referenceName: raw.datasetName,
              type: "DatasetReference",
            },
          },
        ],
        sinks: [
          {
            name: "output",
            dataset: {
              referenceName: curated.datasetName,
              type: "DatasetReference",
            },
          },
        ],
        scriptLines: props.scriptLines,
      },
    });
    return { group, factory, flow };
  });

const v1 = [
  "source(allowSchemaDrift: true, validateSchema: false) ~> input",
  "input sink(allowSchemaDrift: true, validateSchema: false) ~> output",
];
const v2 = [
  "source(allowSchemaDrift: true, validateSchema: false) ~> input",
  "input sink(allowSchemaDrift: true, validateSchema: false, skipDuplicateMapInputs: true, skipDuplicateMapOutputs: true) ~> output",
];

// ~$0: the data flow is defined but never executed. ~1-2 minutes.
test.provider(
  "create, update, and delete a mapping data flow",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, flow } = yield* stack.deploy(
        program({ scriptLines: v1 }),
      );
      expect(flow.type).toEqual("MappingDataFlow");
      const observed = yield* getDataFlow(
        group.resourceGroupName,
        factory.factoryName,
        flow.dataFlowName,
      );
      expect(observed.properties.type).toEqual("MappingDataFlow");
      expect(observed.properties.typeProperties).toMatchObject({
        scriptLines: v1,
      });

      // In place: script lines.
      const updated = yield* stack.deploy(program({ scriptLines: v2 }));
      expect(updated.flow.dataFlowName).toEqual(flow.dataFlowName);
      const reobserved = yield* getDataFlow(
        group.resourceGroupName,
        factory.factoryName,
        flow.dataFlowName,
      );
      expect(reobserved.properties.typeProperties).toMatchObject({
        scriptLines: v2,
      });

      yield* stack.destroy();
      expect(
        yield* dataFlowGone(
          group.resourceGroupName,
          factory.factoryName,
          flow.dataFlowName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
