import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseDefault, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (resourceGroupName: string, workspaceName: string, name: string) =>
  Effect.gen(function* () {
    return yield* ml.GetFeaturesetVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
      version: "1",
    });
  });

const program = (props: { description: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const base = yield* baseDefault("FeatureStore");
    const entity = yield* Azure.MachineLearning.FeaturestoreEntityVersion("AccountV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: "account",
      version: "1",
      indexColumns: [{ columnName: "accountID", dataType: "String" }],
    });
    const featureset = yield* Azure.MachineLearning.FeaturesetVersion("TransactionsV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: "transactions",
      version: "1",
      specificationPath: Output.interpolate`https://${base.storage.storageAccountName}.blob.core.windows.net/featurestore/featuresets/transactions/spec`,
      entities: [Output.interpolate`azureml:${entity.name}:${entity.version}`],
      description: props.description,
      tags: props.tags,
    });
    return { ...base, featureset };
  });

// Skipped: the version needs a `FeatureSetSpec.yaml` uploaded under
// `specificationPath` first, and the test has no blob upload step yet.
// (The earlier blocker, "Received workspace of type feature store with no
// feature store settings", is fixed by `Workspace.featureStoreSettings`.)
// Feature sets are free; the FeatureStore workspace has no hourly charge. ~4-6 minutes.
test.provider.skip(
  "create, update, and delete a feature set version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, featureset } = yield* stack.deploy(
        program({ description: "v1", tags: { env: "test" } }),
      );
      const get = () =>
        getVersion(group.resourceGroupName, workspace.workspaceName, featureset.name);
      let observed = yield* get();
      expect(observed.properties.description).toEqual("v1");
      // Azure rejects `alchemy::*` tag keys here: only the user tags are sent.
      expect(observed.properties.tags).toEqual({ env: "test" });
      expect(observed.properties.entities).toEqual(["azureml:account:1"]);

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.featureset.versionId).toEqual(featureset.versionId);
      observed = yield* get();
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
