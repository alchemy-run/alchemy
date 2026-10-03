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

const getDataset = (
  resourceGroupName: string,
  factoryName: string,
  datasetName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetDataset({
      subscriptionId,
      resourceGroupName,
      factoryName,
      datasetName,
    });
  });

const datasetGone = (
  resourceGroupName: string,
  factoryName: string,
  datasetName: string,
) =>
  getDataset(resourceGroupName, factoryName, datasetName).pipe(
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

const program = (props: { folder: string; folderPath: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("DatasetGroup", {
      location: "eastus",
    });
    const factory = yield* Azure.DataFactory.Factory("DatasetFactory", {
      resourceGroup: group.resourceGroupName,
      identity: { type: "SystemAssigned" },
    });
    // Data Factory does not validate the endpoint when the definition is
    // saved, so no storage account is needed.
    const blob = yield* Azure.DataFactory.LinkedService("Blob", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "AzureBlobStorage",
      typeProperties: {
        serviceEndpoint: "https://alchemydatasettest.blob.core.windows.net/",
        accountKind: "StorageV2",
      },
    });
    const dataset = yield* Azure.DataFactory.Dataset("Orders", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      type: "DelimitedText",
      linkedServiceName: { referenceName: blob.linkedServiceName },
      typeProperties: {
        location: {
          type: "AzureBlobStorageLocation",
          container: "raw",
          folderPath: props.folderPath,
        },
        columnDelimiter: ",",
        firstRowAsHeader: true,
      },
      folder: props.folder,
    });
    return { group, factory, blob, dataset };
  });

// ~$0: dataset definitions are free. ~1-2 minutes.
test.provider(
  "create, update, and delete a dataset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, factory, blob, dataset } = yield* stack.deploy(
        program({ folder: "raw", folderPath: "orders" }),
      );
      expect(dataset.type).toEqual("DelimitedText");
      expect(dataset.folder).toEqual("raw");
      const observed = yield* getDataset(
        group.resourceGroupName,
        factory.factoryName,
        dataset.datasetName,
      );
      expect(observed.properties.linkedServiceName.referenceName).toEqual(
        blob.linkedServiceName,
      );
      expect(observed.properties.typeProperties).toMatchObject({
        location: { container: "raw", folderPath: "orders" },
        firstRowAsHeader: true,
      });

      // In place: folder and location.
      const updated = yield* stack.deploy(
        program({ folder: "curated", folderPath: "orders/2026" }),
      );
      expect(updated.dataset.datasetName).toEqual(dataset.datasetName);
      expect(updated.dataset.folder).toEqual("curated");
      const reobserved = yield* getDataset(
        group.resourceGroupName,
        factory.factoryName,
        dataset.datasetName,
      );
      expect(reobserved.properties.folder?.name).toEqual("curated");
      expect(reobserved.properties.typeProperties).toMatchObject({
        location: { folderPath: "orders/2026" },
      });

      yield* stack.destroy();
      expect(
        yield* datasetGone(
          group.resourceGroupName,
          factory.factoryName,
          dataset.datasetName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
