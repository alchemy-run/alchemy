import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { baseProject, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDatastore = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetDatastore({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (props: {
  container: "Raw" | "Curated";
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const base = yield* baseProject();
    // Both containers stay deployed across the replacement step.
    const raw = yield* Azure.Storage.BlobContainer("Raw", {
      resourceGroup: base.group.resourceGroupName,
      storageAccount: base.storage.storageAccountName,
    });
    const curated = yield* Azure.Storage.BlobContainer("Curated", {
      resourceGroup: base.group.resourceGroupName,
      storageAccount: base.storage.storageAccountName,
    });
    const container = props.container === "Raw" ? raw : curated;
    const datastore = yield* Azure.MachineLearning.Datastore("Training", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      accountName: base.storage.storageAccountName,
      containerName: container.containerName,
      description: props.description,
      tags: props.tags,
    });
    return { ...base, container, datastore };
  });

// Datastores are free; the hub workspace has no hourly charge. ~3-5 minutes.
test.provider(
  "create, replace, and delete a blob datastore",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, container, datastore } = yield* stack.deploy(
        program({
          container: "Raw",
          description: "raw",
          tags: { env: "test" },
        }),
      );
      const get = (name: string) =>
        getDatastore(group.resourceGroupName, workspace.workspaceName, name);
      expect(datastore.datastoreName).toMatch(/^[a-z0-9_]+$/);
      expect(datastore.datastoreType).toEqual("AzureBlob");
      expect(datastore.isDefault).toEqual(false);
      const observed = yield* get(datastore.datastoreName);
      expect(observed.properties.containerName).toEqual(
        container.containerName,
      );
      expect(observed.properties.credentials.credentialsType).toEqual("None");
      expect(observed.properties.description).toEqual("raw");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("Training");

      // Replacement: Azure ignores updates, so a new description replaces
      // the datastore.
      const redescribed = yield* stack.deploy(
        program({
          container: "Raw",
          description: "raw v2",
          tags: { env: "prod" },
        }),
      );
      expect(redescribed.datastore.datastoreName).not.toEqual(
        datastore.datastoreName,
      );
      const reobserved = yield* get(redescribed.datastore.datastoreName);
      expect(reobserved.properties.description).toEqual("raw v2");
      expect(reobserved.properties.tags?.env).toEqual("prod");
      expect(yield* waitGone(get(datastore.datastoreName))).toEqual("gone");

      // Replacement: a different container.
      const replaced = yield* stack.deploy(
        program({
          container: "Curated",
          description: "curated",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.datastore.datastoreName).not.toEqual(
        redescribed.datastore.datastoreName,
      );
      const replacedObserved = yield* get(replaced.datastore.datastoreName);
      expect(replacedObserved.properties.containerName).toEqual(
        replaced.container.containerName,
      );
      expect(yield* waitGone(get(redescribed.datastore.datastoreName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.datastore.datastoreName))).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
