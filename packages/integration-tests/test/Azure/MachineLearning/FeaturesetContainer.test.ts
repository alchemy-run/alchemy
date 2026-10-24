import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseWorkspace, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContainer = (resourceGroupName: string, workspaceName: string, name: string) =>
  Effect.gen(function* () {
    return yield* ml.GetFeaturesetContainerEntity({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
    });
  });

const program = (props: {
  name?: string;
  description?: string;
  tags: Record<string, string>;
  isArchived?: boolean;
}) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace({ kind: "FeatureStore" });
    const container = yield* Azure.MachineLearning.FeaturesetContainer("Transactions", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      ...props,
    });
    return { ...base, container };
  });

// Feature set assets are free; the FeatureStore workspace has no hourly charge. ~4-6 minutes.
// The registry path is covered by FeaturesetVersion.test.ts.
// Skipped: BadRequest: Received workspace of type feature store with no feature store settings. — Workspace does not expose `featureStoreSettings` yet.
test.provider.skip(
  "create, update, rename, and delete a feature set container",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, container } = yield* stack.deploy(
        program({ description: "transactions", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getContainer(group.resourceGroupName, workspace.workspaceName, name);
      expect(container.containerName).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(container.workspace).toEqual(workspace.workspaceName);
      expect(container.registry).toBeUndefined();
      expect(container.tags).toEqual({ env: "test" });
      const observed = yield* get(container.containerName);
      expect(observed.properties.description).toEqual("transactions");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("Transactions");

      // In place: description, tags, archive flag.
      const updated = yield* stack.deploy(
        program({ description: "transactions v2", tags: { env: "prod" }, isArchived: true }),
      );
      expect(updated.container.containerId).toEqual(container.containerId);
      const reobserved = yield* get(container.containerName);
      expect(reobserved.properties.description).toEqual("transactions v2");
      expect(reobserved.properties.tags?.env).toEqual("prod");
      expect(reobserved.properties.isArchived).toEqual(true);

      // Replacement: an explicit name.
      const renamed = yield* stack.deploy(
        program({ name: "alchemy-transactions-renamed", description: "renamed", tags: {} }),
      );
      expect(renamed.container.containerName).toEqual("alchemy-transactions-renamed");
      const renamedObserved = yield* get("alchemy-transactions-renamed");
      expect(renamedObserved.properties.description).toEqual("renamed");
      expect(renamedObserved.properties.isArchived ?? false).toEqual(false);
      expect(yield* waitGone(get(container.containerName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-transactions-renamed"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
