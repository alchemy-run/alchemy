import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import type { InputProps } from "alchemy/Input";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { baseDefault, logLevel, subscription, tags, waitGone } from "./util.ts";

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
  stage?: string;
  withVersion?: boolean;
}) =>
  Effect.gen(function* () {
    const base = yield* baseDefault("FeatureStore");
    const container = yield* Azure.MachineLearning.FeaturestoreEntityContainer("Account", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
    });
    if (props.withVersion === false) return { ...base, container, version: undefined };
    const version = yield* Azure.MachineLearning.FeaturestoreEntityVersion("AccountV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: container.containerName,
      version: props.version,
      description: props.description,
      tags: props.tags,
      stage: props.stage,
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
test.provider(
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
      // Azure rejects `alchemy::*` tag keys here: only the user tags are sent.
      expect(version?.tags).toEqual({ env: "test" });
      let observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags).toEqual({ env: "test" });
      expect(observed.properties.indexColumns?.map((c) => c.columnName)).toEqual(["accountID"]);

      // In place: description, tags, and stage.
      const updated = yield* stack.deploy(
        program({
          variant: "a",
          version: "1",
          description: "v1 updated",
          tags: { env: "prod" },
          stage: "Production",
        }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.stage).toEqual("Production");
      expect(observed.properties.tags).toEqual({ env: "prod" });

      // Replacement: Azure never reuses a deleted version id, so new content
      // takes a new version and the old one is deleted.
      const replaced = yield* stack.deploy(
        program({
          variant: "b",
          version: "2",
          description: "v1 updated",
          tags: { env: "prod" },
          stage: "Production",
        }),
      );
      expect(replaced.version?.version).toEqual("2");
      observed = yield* get("2");
      expect(observed.properties.indexColumns?.map((c) => c.columnName)).toEqual([
        "accountID",
        "region",
      ]);
      expect(yield* waitGone(get("1"))).toEqual("gone");

      // Removing the version deletes it; the container stays.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "2",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect(yield* waitGone(get("2"))).toEqual("gone");
      const subscriptionId = yield* subscription;
      const observedContainer = yield* ml.GetFeaturestoreEntityContainerEntity({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        workspaceName: workspace.workspaceName,
        name: container.containerName,
      });
      expect(observedContainer.id).toEqual(container.containerId);

      yield* stack.destroy();
      expect(yield* waitGone(get("2"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
