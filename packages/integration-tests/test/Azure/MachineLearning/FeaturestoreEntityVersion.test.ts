import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import type { InputProps } from "alchemy/Input";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseWorkspace, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetFeaturestoreEntityVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
      version,
    });
  });

const program = (props: {
  variant: "a" | "b";
  version: "1" | "2";
  description: string;
  tags: Record<string, string>;
  withVersion?: boolean;
}) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace({ kind: "FeatureStore" });
    const container = yield* Azure.MachineLearning.FeaturestoreEntityContainer("Account", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      tags: { role: "container" },
    });
    if (props.withVersion === false) return { ...base, container, version: undefined };
    const version = yield* Azure.MachineLearning.FeaturestoreEntityVersion("AccountV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: container.containerName,
      version: props.version,
      description: props.description,
      tags: props.tags,
      ...(props.variant === "a"
        ? ({ indexColumns: [{ columnName: "accountID", dataType: "String" }] } satisfies Partial<
            InputProps<Azure.MachineLearning.FeaturestoreEntityVersionProps>
          >)
        : ({
            indexColumns: [
              { columnName: "accountID", dataType: "String" },
              { columnName: "region", dataType: "String" },
            ],
          } satisfies Partial<InputProps<Azure.MachineLearning.FeaturestoreEntityVersionProps>>)),
    });
    return { ...base, container, version };
  });

// Feature store entity assets are free; the FeatureStore workspace has no hourly charge. ~4-6 minutes.
// Skipped: BadRequest: Received workspace of type feature store with no feature store settings. — Workspace does not expose `featureStoreSettings` yet.
test.provider.skip(
  "create, update, replace, and delete a feature store entity version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, container, version } = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1", tags: { env: "test" } }),
      );
      const get = (v: string) =>
        getVersion(group.resourceGroupName, workspace.workspaceName, version?.name ?? "", v);
      expect(version?.version).toEqual("1");
      expect(version?.tags).toEqual({ env: "test" });
      let observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("AccountV1");
      expect(observed.properties.indexColumns?.map((c) => c.columnName)).toEqual(["accountID"]);

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      // Replacement at the same name and version: new content.
      yield* stack.deploy(
        program({ variant: "b", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      observed = yield* get("1");
      expect(observed.properties.indexColumns?.map((c) => c.columnName)).toEqual([
        "accountID",
        "region",
      ]);

      // Removing the version deletes it; the container stays.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "1",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect(yield* waitGone(get("1"))).toEqual("gone");
      const observedContainer = yield* ml.GetFeaturestoreEntityContainerEntity({
        subscriptionId: yield* subscription,
        resourceGroupName: group.resourceGroupName,
        workspaceName: workspace.workspaceName,
        name: container.containerName,
      });
      expect(observedContainer.properties.tags?.role).toEqual("container");

      yield* stack.destroy();
      expect(yield* waitGone(get("1"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
