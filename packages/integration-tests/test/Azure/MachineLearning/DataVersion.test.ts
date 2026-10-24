import * as Azure from "@alchemy.run/azure";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import type { InputProps } from "alchemy/Input";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { baseDefault, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  workspaceName: string,
  name: string,
  version: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetDataVersion({
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
    const base = yield* baseDefault();
    const container = yield* Azure.MachineLearning.DataContainer("Iris", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      dataType: "uri_file",
      tags: { role: "container" },
    });
    if (props.withVersion === false) return { ...base, container, version: undefined };
    const version = yield* Azure.MachineLearning.DataVersion("IrisV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: container.containerName,
      version: props.version,
      description: props.description,
      tags: props.tags,
      ...(props.variant === "a"
        ? ({
            dataType: "uri_file",
            dataUri: "https://azuremlexamples.blob.core.windows.net/datasets/iris.csv",
          } satisfies Partial<InputProps<Azure.MachineLearning.DataVersionProps>>)
        : ({
            dataType: "uri_file",
            dataUri: "https://azuremlexamples.blob.core.windows.net/datasets/titanic.csv",
          } satisfies Partial<InputProps<Azure.MachineLearning.DataVersionProps>>)),
    });
    return { ...base, container, version };
  });

// Data assets are free; the Default workspace has no hourly charge. ~4-6 minutes.
test.provider(
  "create, update, replace, and delete a data version",
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
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("IrisV1");
      expect(observed.properties.dataUri).toEqual(
        "https://azuremlexamples.blob.core.windows.net/datasets/iris.csv",
      );

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      // Azure only archives workspace data versions: new content takes a
      // new version, and the old one is archived.
      yield* stack.deploy(
        program({ variant: "b", version: "2", description: "v1 updated", tags: { env: "prod" } }),
      );
      observed = yield* get("2");
      expect(observed.properties.dataUri).toEqual(
        "https://azuremlexamples.blob.core.windows.net/datasets/titanic.csv",
      );
      expect((yield* get("1")).properties.isArchived).toEqual(true);

      // Removing the version archives it; the container stays.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "2",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect((yield* get("2")).properties.isArchived).toEqual(true);
      const observedContainer = yield* ml.GetDataContainer({
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

const registryProgram = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", { location });
  const registry = yield* Azure.MachineLearning.Registry("Shared", {
    resourceGroup: group.resourceGroupName,
    location,
  });
  const container = yield* Azure.MachineLearning.DataContainer("Iris", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    description: "shared",
  });
  const version = yield* Azure.MachineLearning.DataVersion("IrisV1", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    name: container.containerName,
    version: "1",
    description: "shared v1",
    dataType: "uri_file",
    dataUri: "https://azuremlexamples.blob.core.windows.net/datasets/iris.csv",
  });
  return { group, registry, container, version };
});

// ~$0.10/run, 20 min: a registry provisions a managed Premium container
// registry and storage account and takes ~5-7 minutes to create and delete.
test.provider.skipIf(!runExpensive)(
  "create and delete a data container and version in a registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, container, version } = yield* stack.deploy(registryProgram);
      const subscriptionId = yield* subscription;
      expect(container.registry).toEqual(registry.registryName);
      expect(version.registry).toEqual(registry.registryName);
      const observedContainer = yield* ml.GetRegistryDataContainer({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        name: container.containerName,
      });
      expect(observedContainer.properties.description).toEqual("shared");
      const getVersion = ml.GetRegistryDataVersion({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        name: container.containerName,
        version: "1",
      });
      const observedVersion = yield* getVersion;
      expect(observedVersion.properties.description).toEqual("shared v1");
      expect(observedVersion.properties.tags?.["alchemy::id"]).toEqual("IrisV1");

      yield* stack.destroy();
      expect(yield* waitGone(getVersion)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
