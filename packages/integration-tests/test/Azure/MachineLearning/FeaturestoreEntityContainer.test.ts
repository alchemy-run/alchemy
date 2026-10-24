import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseDefault, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (resourceGroupName: string, workspaceName: string, name: string) =>
  Effect.gen(function* () {
    return yield* ml.GetFeaturestoreEntityContainerEntity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (props: { name?: string }) =>
  Effect.gen(function* () {
    const base = yield* baseDefault("FeatureStore");
    const container = yield* Azure.MachineLearning.FeaturestoreEntityContainer("Account", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      ...props,
    });
    return { ...base, container };
  });

// Feature store entity containers are existence-only (see the resource docs).
// Feature store entity assets are free; the FeatureStore workspace has no hourly charge. ~4-6 minutes.
test.provider(
  "create, update, rename, and delete a feature store entity container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, container } = yield* stack.deploy(program({}));
      const get = (name: string) =>
        getContainer(group.resourceGroupName, workspace.workspaceName, name);
      expect(container.containerName).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(container.workspace).toEqual(workspace.workspaceName);
      expect(container.registry).toBeUndefined();
      // Azure rejects container tags and descriptions and ignores the archive
      // flag; the workspace's tags mark ownership.
      expect(container.tags).toEqual({});
      const subscriptionId = yield* subscription;
      const store = yield* ml.GetWorkspace({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        workspaceName: workspace.workspaceName,
      });
      expect(store.properties?.featureStoreSettings?.computeRuntime?.sparkRuntimeVersion).toEqual(
        "3.4.0",
      );
      expect(store.tags?.["alchemy::id"]).toEqual("Workspace");
      const observed = yield* get(container.containerName);
      expect(observed.properties.isArchived ?? false).toEqual(false);
      expect(observed.properties.tags ?? {}).toEqual({});

      // Redeploying the same props is a no-op.
      const again = yield* stack.deploy(program({}));
      expect(again.container.containerId).toEqual(container.containerId);

      // Replacement: an explicit name.
      const renamed = yield* stack.deploy(program({ name: "alchemy-account-renamed" }));
      expect(renamed.container.containerName).toEqual("alchemy-account-renamed");
      const renamedObserved = yield* get("alchemy-account-renamed");
      expect(renamedObserved.id).toEqual(renamed.container.containerId);
      expect(yield* waitGone(get(container.containerName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-account-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
