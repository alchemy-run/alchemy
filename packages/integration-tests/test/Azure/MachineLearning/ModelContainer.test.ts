import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseDefault, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (resourceGroupName: string, workspaceName: string, name: string) =>
  Effect.gen(function* () {
    return yield* ml.GetModelContainer({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (props: { name?: string; description?: string; isArchived?: boolean }) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    const container = yield* Azure.MachineLearning.ModelContainer("Churn", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      ...props,
    });
    return { ...base, container };
  });

// Model assets are free; the Default workspace has no hourly charge. ~4-6 minutes.
// The registry path is covered by ModelVersion.test.ts.
test.provider(
  "create, update, rename, and delete a model container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, container } = yield* stack.deploy(
        program({ description: "churn" }),
      );
      const get = (name: string) =>
        getContainer(group.resourceGroupName, workspace.workspaceName, name);
      expect(container.containerName).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(container.workspace).toEqual(workspace.workspaceName);
      expect(container.registry).toBeUndefined();
      // Workspace model containers drop tags; the workspace's tags mark ownership.
      expect(container.tags).toEqual({});
      const observed = yield* get(container.containerName);
      expect(observed.properties.description).toEqual("churn");
      expect(observed.properties.tags ?? {}).toEqual({});

      // In place: description and archive flag.
      const updated = yield* stack.deploy(program({ description: "churn v2", isArchived: true }));
      expect(updated.container.containerId).toEqual(container.containerId);
      const reobserved = yield* get(container.containerName);
      expect(reobserved.properties.description).toEqual("churn v2");
      expect(reobserved.properties.isArchived).toEqual(true);

      // Replacement: an explicit name.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-churn-renamed", description: "renamed" }),
      );
      expect(renamed.container.containerName).toEqual("alchemy-churn-renamed");
      const renamedObserved = yield* get("alchemy-churn-renamed");
      expect(renamedObserved.properties.description).toEqual("renamed");
      expect(renamedObserved.properties.isArchived ?? false).toEqual(false);
      expect(yield* waitGone(get(container.containerName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-churn-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
