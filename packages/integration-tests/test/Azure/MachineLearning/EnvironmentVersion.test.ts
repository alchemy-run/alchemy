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
    return yield* ml.GetEnvironmentVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      name,
      version,
    });
  });

/** Azure answers reads of a deleted environment version with a typed 400. */
const deletedTag = <A, E extends { _tag: string }, R>(get: Effect.Effect<A, E, R>) =>
  get.pipe(
    Effect.flip,
    Effect.map((error) => error._tag),
  );

const program = (props: {
  variant: "a" | "b";
  version: "1" | "2";
  description: string;
  tags: Record<string, string>;
  withVersion?: boolean;
}) =>
  Effect.gen(function* () {
    const base = yield* baseDefault();
    if (props.withVersion === false) return { ...base, version: undefined };
    const version = yield* Azure.MachineLearning.EnvironmentVersion("RuntimeV1", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      name: "runtime",
      version: props.version,
      description: props.description,
      tags: props.tags,
      ...(props.variant === "a"
        ? ({ image: "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest" } satisfies Partial<
            InputProps<Azure.MachineLearning.EnvironmentVersionProps>
          >)
        : ({ image: "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu20.04:latest" } satisfies Partial<
            InputProps<Azure.MachineLearning.EnvironmentVersionProps>
          >)),
    });
    return { ...base, version };
  });

// Environment assets are free; the Default workspace has no hourly charge. ~4-6 minutes.
test.provider(
  "create, update, replace, and delete an environment version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, version } = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1", tags: { env: "test" } }),
      );
      const get = (v: string) =>
        getVersion(group.resourceGroupName, workspace.workspaceName, "runtime", v);
      expect(version?.version).toEqual("1");
      expect(version?.tags).toEqual({ env: "test" });
      let observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1");
      expect(observed.properties.tags?.env).toEqual("test");
      expect(observed.properties.tags?.["alchemy::id"]).toEqual("RuntimeV1");
      expect(observed.properties.image).toEqual(
        "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest",
      );

      // In place: description and tags.
      const updated = yield* stack.deploy(
        program({ variant: "a", version: "1", description: "v1 updated", tags: { env: "prod" } }),
      );
      expect(updated.version?.versionId).toEqual(version?.versionId);
      observed = yield* get("1");
      expect(observed.properties.description).toEqual("v1 updated");
      expect(observed.properties.tags?.env).toEqual("prod");

      // Azure never reuses a deleted environment id: new content takes a new
      // version, and the old one is deleted.
      yield* stack.deploy(
        program({ variant: "b", version: "2", description: "v1 updated", tags: { env: "prod" } }),
      );
      observed = yield* get("2");
      expect(observed.properties.image).toEqual(
        "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu20.04:latest",
      );
      expect(yield* deletedTag(get("1"))).toEqual("MachineLearningAssetVersionDeleted");

      // Removing the version deletes it.
      yield* stack.deploy(
        program({
          variant: "b",
          version: "2",
          description: "v1 updated",
          tags: {},
          withVersion: false,
        }),
      );
      expect(yield* deletedTag(get("2"))).toEqual("MachineLearningAssetVersionDeleted");

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
  const container = yield* Azure.MachineLearning.EnvironmentContainer("Runtime", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    description: "shared",
  });
  const version = yield* Azure.MachineLearning.EnvironmentVersion("RuntimeV1", {
    resourceGroup: group.resourceGroupName,
    registry: registry.registryName,
    name: container.containerName,
    version: "1",
    description: "shared v1",
    image: "mcr.microsoft.com/azureml/openmpi4.1.0-ubuntu22.04:latest",
  });
  return { group, registry, container, version };
});

// ~$0.10/run, 20 min: a registry provisions a managed Premium container
// registry and storage account and takes ~5-7 minutes to create and delete.
test.provider.skipIf(!runExpensive)(
  "create and delete a environment container and version in a registry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registry, container, version } = yield* stack.deploy(registryProgram);
      const subscriptionId = yield* subscription;
      expect(container.registry).toEqual(registry.registryName);
      expect(version.registry).toEqual(registry.registryName);
      const observedContainer = yield* ml.GetRegistryEnvironmentContainer({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        environmentName: container.containerName,
      });
      expect(observedContainer.properties.description).toEqual("shared");
      const getVersion = ml.GetRegistryEnvironmentVersion({
        subscriptionId,
        resourceGroupName: group.resourceGroupName,
        registryName: registry.registryName,
        environmentName: container.containerName,
        version: "1",
      });
      const observedVersion = yield* getVersion;
      expect(observedVersion.properties.description).toEqual("shared v1");
      expect(observedVersion.properties.tags?.["alchemy::id"]).toEqual("RuntimeV1");

      yield* stack.destroy();
      expect(yield* waitGone(getVersion)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_800_000 },
);
